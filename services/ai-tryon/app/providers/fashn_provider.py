from __future__ import annotations

import asyncio
import base64
import io
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from app.preprocessing.normalizer import normalize_user_portrait_3x4
from app.providers.base import (
    GENERATIVE_VTON_BADGE,
    BaseVtonProvider,
    ClothType,
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

FASHN_CATEGORY_MAP: dict[ClothType, str] = {
    "upper": "tops",
    "outerwear": "tops",
    "lower": "bottoms",
    "overall": "one-pieces",
}


class FashnVtonProvider(BaseVtonProvider):
    """
    Tier 1 Commercial Cloud VTON via FASHN.ai API (`tryon-v1.5`, `4-8s`).
    `POST https://api.fashn.ai/v1/run` + `GET https://api.fashn.ai/v1/status/{id}` polling.
    Active only when `FASHN_API_KEY` is non-empty.
    """

    name: str = "fashn"
    provider_type: VTONProviderType = "FASHN_VTON"
    capabilities: ProviderCapabilities = ProviderCapabilities(
        name="fashn",
        display_name="FASHN.ai tryon-v1.5 Cloud Adapter (Tier 1)",
        mode="remote-api",
        supported_categories=("TOP", "BOTTOM", "ONE_PIECE", "OUTERWEAR"),
        supported_aspect_ratios=("3:4", "2:3"),
        supports_alpha_cutout=True,
        status="active",
    )

    def __init__(
        self,
        *,
        api_key: str,
        api_url: str = "https://api.fashn.ai/v1/run",
        model_name: str = "tryon-v1.5",
        timeout_seconds: float = 45.0,
        private_bucket: str = "atelier-private-tryon",
        purge_ttl_minutes: int = 15,
    ) -> None:
        self.api_key = (api_key or "").strip()
        self.api_url = (api_url or "https://api.fashn.ai/v1/run").strip().rstrip("/")
        self.model_name = (model_name or "tryon-v1.5").strip()
        self.timeout_seconds = max(5.0, float(timeout_seconds))
        self.private_bucket = private_bucket
        self.purge_ttl_minutes = purge_ttl_minutes

    @property
    def _status_base_url(self) -> str:
        if self.api_url.endswith("/run"):
            return self.api_url[: -len("/run")] + "/status"
        return f"{self.api_url}/status"

    @staticmethod
    def _to_data_uri(payload: bytes, mime: str = "image/png") -> str:
        return f"data:{mime};base64,{base64.b64encode(payload).decode('ascii')}"

    @staticmethod
    def _normalize_person_png(person_bytes: bytes) -> bytes:
        canvas = normalize_user_portrait_3x4(person_bytes, target_size=(CANVAS_W, CANVAS_H))
        out = io.BytesIO()
        canvas.convert("RGB").save(out, format="PNG")
        return out.getvalue()

    async def synthesize(self, request: TryOnGenerationRequest) -> TryOnGenerationResult:
        if not self.api_key:
            raise RuntimeError("FASHN_API_KEY is not configured; cannot execute FashnVtonProvider.")

        started = time.perf_counter()
        budget = min(self.timeout_seconds, float(request.timeout_seconds or self.timeout_seconds))
        deadline = time.monotonic() + budget

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
            "model_name": self.model_name,
            "inputs": {
                "model_image": self._to_data_uri(person_png, "image/png"),
                "garment_image": self._to_data_uri(garment_png, "image/png"),
                "category": FASHN_CATEGORY_MAP[cloth_type],
                "garment_photo_type": "flat-lay",
                "mode": "balanced",
            },
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=httpx.Timeout(budget, connect=8.0)) as client:
            run_resp = await client.post(self.api_url, json=payload, headers=headers)
            if run_resp.status_code >= 400:
                raise RuntimeError(
                    f"FASHN.ai run HTTP {run_resp.status_code}: {run_resp.text[:240]}"
                )
            run_data: dict[str, Any] = run_resp.json()
            pred_id = str(run_data.get("id") or run_data.get("prediction_id") or "").strip()
            if not pred_id:
                raise RuntimeError("FASHN.ai response did not include a prediction id.")

            output_url: str | None = None
            status_url = f"{self._status_base_url}/{pred_id}"

            while time.monotonic() < deadline:
                st_resp = await client.get(status_url, headers=headers)
                if st_resp.status_code >= 400:
                    raise RuntimeError(
                        f"FASHN.ai status HTTP {st_resp.status_code}: {st_resp.text[:200]}"
                    )
                st_data: dict[str, Any] = st_resp.json()
                st_val = str(st_data.get("status") or "").lower()
                if st_val == "completed":
                    out_field = st_data.get("output")
                    if isinstance(out_field, list) and out_field:
                        output_url = str(out_field[0])
                    elif isinstance(out_field, str) and out_field.strip():
                        output_url = out_field.strip()
                    break
                if st_val in ("failed", "canceled", "cancelled", "error"):
                    err_detail = st_data.get("error") or st_val
                    raise RuntimeError(f"FASHN.ai prediction {pred_id} failed: {err_detail}")
                await asyncio.sleep(min(1.2, max(0.3, deadline - time.monotonic())))

            if not output_url:
                raise TimeoutError(
                    f"FASHN.ai prediction {pred_id} timed out after {budget:.1f}s."
                )

            img_resp = await client.get(output_url)
            img_resp.raise_for_status()
            normalized_bytes = await asyncio.to_thread(
                normalize_output_768x1024, img_resp.content, fmt="WEBP"
            )

        latency_ms = max(1, int((time.perf_counter() - started) * 1000))
        return TryOnGenerationResult(
            result_bytes=normalized_bytes,
            content_type="image/webp",
            provider_used="fashn",
            provider_type="FASHN_VTON",
            provider_badge=GENERATIVE_VTON_BADGE,
            latency_ms=latency_ms,
            clean_collar_applied=clean_collar,
            external_job_id=f"fashn_{pred_id}",
            estimated_cost_usd=0.05,
            width=CANVAS_W,
            height=CANVAS_H,
            notes=f"Generated via FASHN.ai {self.model_name}.",
        )

    async def _generate_legacy_preview(self, request: VTONRequest) -> VTONResult:
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(minutes=self.purge_ttl_minutes)
        return VTONResult(
            job_id=f"fashn_preview_{request.garment_sku_id}",
            provider=self.name,
            status="COMPLETED",
            result_bucket=self.private_bucket,
            result_object_key=f"previews/{request.user_id}/fashn_preview.webp",
            preview_url=f"minio://{self.private_bucket}/previews/{request.user_id}/fashn_preview.webp",
            aspect_ratio=request.aspect_ratio,
            latency_ms=0,
            created_at=now,
            expires_at=expires_at,
            notes="FashnVtonProvider active.",
        )

    async def health_check(self) -> bool:
        return bool(self.api_key)
