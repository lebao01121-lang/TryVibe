from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from app.preprocessing.normalizer import normalize_user_portrait_3x4
from app.providers.base import (
    GENERATIVE_VTON_BADGE,
    BaseVtonProvider,
    ProviderCapabilities,
    TryOnGenerationRequest,
    TryOnGenerationResult,
    VTONProviderType,
    VTONRequest,
    VTONResult,
)
from app.providers.photometric_inpaint_provider import (
    CANVAS_H,
    CANVAS_W,
    composite_garment_studio_white,
    normalize_output_768x1024,
    resolve_bytes_or_url,
)


class LocalGpuVtonProvider(BaseVtonProvider):
    """
    Tier 3 LAN Priority VTON Provider ($0, 100% private internal GPU inference).
    Active when `LOCAL_VTON_ENDPOINT` is non-empty (e.g. `http://192.168.1.50:8000/v1/tryon`).
    Supports JSON base64 or raw image binary responses from self-hosted CatVTON / IDM-VTON / ComfyUI workers.
    """

    name: str = "local_gpu"
    provider_type: VTONProviderType = "LOCAL_GPU_VTON"
    capabilities: ProviderCapabilities = ProviderCapabilities(
        name="local_gpu",
        display_name="Internal LAN GPU VTON Engine (Tier 3 · $0 Private)",
        mode="local-gpu",
        supported_categories=("TOP", "BOTTOM", "ONE_PIECE", "OUTERWEAR"),
        supported_aspect_ratios=("3:4", "2:3"),
        supports_alpha_cutout=True,
        status="active",
    )

    def __init__(
        self,
        *,
        endpoint_url: str,
        timeout_seconds: float = 35.0,
        private_bucket: str = "atelier-private-tryon",
        purge_ttl_minutes: int = 15,
    ) -> None:
        self.endpoint_url = (endpoint_url or "").strip().rstrip("/")
        self.timeout_seconds = max(5.0, float(timeout_seconds))
        self.private_bucket = private_bucket
        self.purge_ttl_minutes = purge_ttl_minutes

    @staticmethod
    def _normalize_person_png(person_bytes: bytes) -> bytes:
        canvas = normalize_user_portrait_3x4(person_bytes, target_size=(CANVAS_W, CANVAS_H))
        out = io.BytesIO()
        canvas.convert("RGB").save(out, format="PNG")
        return out.getvalue()

    async def synthesize(self, request: TryOnGenerationRequest) -> TryOnGenerationResult:
        if not self.endpoint_url:
            raise RuntimeError("LOCAL_VTON_ENDPOINT is not configured.")

        started = time.perf_counter()
        budget = min(self.timeout_seconds, float(request.timeout_seconds or self.timeout_seconds))

        person_bytes = await resolve_bytes_or_url(request.person_bytes, request.human_image_url)
        garment_bytes = await resolve_bytes_or_url(request.garment_bytes, request.garment_image_url)
        cloth_type = request.normalized_cloth_type

        person_png = await asyncio.to_thread(self._normalize_person_png, person_bytes)
        garment_png, clean_collar = await asyncio.to_thread(
            composite_garment_studio_white,
            garment_bytes,
            cloth_type=cloth_type,
            color_hex=request.color_hex,
            output_format="PNG",
        )

        payload: dict[str, Any] = {
            "human_image_b64": base64.b64encode(person_png).decode("ascii"),
            "garment_image_b64": base64.b64encode(garment_png).decode("ascii"),
            "cloth_type": "upper" if cloth_type == "outerwear" else cloth_type,
            "description": request.english_prompt,
            "lighting_preset": request.normalized_lighting_preset,
            "width": CANVAS_W,
            "height": CANVAS_H,
        }

        async with httpx.AsyncClient(timeout=httpx.Timeout(budget, connect=5.0)) as client:
            resp = await client.post(self.endpoint_url, json=payload)
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"LAN GPU VTON HTTP {resp.status_code}: {resp.text[:240]}"
                )

            ct_header = (resp.headers.get("content-type") or "").lower()
            raw_img_bytes: bytes | None = None
            external_job_id = ""

            if ct_header.startswith("image/"):
                raw_img_bytes = resp.content
            else:
                data = resp.json()
                external_job_id = str(data.get("job_id") or data.get("request_id") or "")
                b64_val = (
                    data.get("image_base64")
                    or data.get("result_base64")
                    or data.get("image_b64")
                )
                if isinstance(b64_val, str) and b64_val.strip():
                    cleaned = b64_val.strip()
                    if "," in cleaned and cleaned.startswith("data:"):
                        cleaned = cleaned.split(",", 1)[1]
                    raw_img_bytes = base64.b64decode(cleaned)
                else:
                    img_url = (
                        (data.get("image") or {}).get("url")
                        if isinstance(data.get("image"), dict)
                        else data.get("image_url") or data.get("result_url")
                    )
                    if isinstance(img_url, str) and img_url.strip():
                        img_resp = await client.get(img_url.strip())
                        img_resp.raise_for_status()
                        raw_img_bytes = img_resp.content

            if not raw_img_bytes or len(raw_img_bytes) < 512:
                raise RuntimeError("LAN GPU VTON endpoint returned an empty image payload.")

        normalized_bytes = await asyncio.to_thread(
            normalize_output_768x1024, raw_img_bytes, fmt="WEBP"
        )
        latency_ms = max(1, int((time.perf_counter() - started) * 1000))
        digest = hashlib.sha256(normalized_bytes[:4096]).hexdigest()[:12]
        return TryOnGenerationResult(
            result_bytes=normalized_bytes,
            content_type="image/webp",
            provider_used="local_gpu",
            provider_type="LOCAL_GPU_VTON",
            provider_badge=GENERATIVE_VTON_BADGE,
            latency_ms=latency_ms,
            clean_collar_applied=clean_collar,
            external_job_id=external_job_id or f"localgpu_{digest}",
            estimated_cost_usd=0.0,
            width=CANVAS_W,
            height=CANVAS_H,
            notes=f"Generated via private LAN GPU VTON ({self.endpoint_url}).",
        )

    async def _generate_legacy_preview(self, request: VTONRequest) -> VTONResult:
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(minutes=self.purge_ttl_minutes)
        return VTONResult(
            job_id=f"localgpu_preview_{request.garment_sku_id}",
            provider=self.name,
            status="COMPLETED",
            result_bucket=self.private_bucket,
            result_object_key=f"previews/{request.user_id}/localgpu_preview.webp",
            preview_url=f"minio://{self.private_bucket}/previews/{request.user_id}/localgpu_preview.webp",
            aspect_ratio=request.aspect_ratio,
            latency_ms=0,
            created_at=now,
            expires_at=expires_at,
            notes="LocalGpuVtonProvider active.",
        )

    async def health_check(self) -> bool:
        return bool(self.endpoint_url)
