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

FAL_CATVTON_CLOTH_MAP: dict[ClothType, str] = {
    "upper": "upper",
    "outerwear": "upper",
    "lower": "lower",
    "overall": "overall",
}

FAL_IDM_CATEGORY_MAP: dict[ClothType, str] = {
    "upper": "upper_body",
    "outerwear": "upper_body",
    "lower": "lower_body",
    "overall": "dresses",
}


class FalCatVtonProvider(BaseVtonProvider):
    """
    Tier 1 Commercial Cloud VTON via fal.ai async Queue REST API (`4-8s`).
    Supports `fal-ai/cat-vton` (default), `fal-ai/idm-vton`, and `fal-ai/leffa`.
    Active only when `FAL_KEY` is non-empty.
    """

    name: str = "fal"
    provider_type: VTONProviderType = "FAL_CATVTON"
    capabilities: ProviderCapabilities = ProviderCapabilities(
        name="fal",
        display_name="fal.ai Cloud VTON Adapter (CatVTON / IDM-VTON / Leffa · Tier 1)",
        mode="remote-api",
        supported_categories=("TOP", "BOTTOM", "ONE_PIECE", "OUTERWEAR"),
        supported_aspect_ratios=("3:4", "2:3"),
        supports_alpha_cutout=True,
        status="active",
    )

    def __init__(
        self,
        *,
        fal_key: str,
        fal_vton_model: str = "fal-ai/cat-vton",
        endpoint_url: str | None = None,
        timeout_seconds: float = 45.0,
        private_bucket: str = "atelier-private-tryon",
        purge_ttl_minutes: int = 15,
    ) -> None:
        self.fal_key = (fal_key or "").strip()
        self.fal_vton_model = (fal_vton_model or "fal-ai/cat-vton").strip().lstrip("/")
        if endpoint_url and endpoint_url.strip():
            raw = endpoint_url.strip().rstrip("/")
            if raw == "https://queue.fal.run/fal-ai/cat-vton" and self.fal_vton_model != "fal-ai/cat-vton":
                self.endpoint_url = f"https://queue.fal.run/{self.fal_vton_model}"
            else:
                self.endpoint_url = raw
        else:
            self.endpoint_url = f"https://queue.fal.run/{self.fal_vton_model}"
        self.timeout_seconds = max(5.0, float(timeout_seconds))
        self.private_bucket = private_bucket
        self.purge_ttl_minutes = purge_ttl_minutes

    @staticmethod
    def _to_data_uri(payload: bytes, mime: str = "image/png") -> str:
        encoded = base64.b64encode(payload).decode("ascii")
        return f"data:{mime};base64,{encoded}"

    @staticmethod
    def _normalize_person_png(person_bytes: bytes) -> bytes:
        canvas = normalize_user_portrait_3x4(person_bytes, target_size=(CANVAS_W, CANVAS_H))
        out = io.BytesIO()
        canvas.convert("RGB").save(out, format="PNG")
        return out.getvalue()

    def _build_payload(
        self,
        *,
        human_uri: str,
        garment_uri: str,
        cloth_type: ClothType,
        english_prompt: str,
    ) -> dict[str, Any]:
        model_lower = self.fal_vton_model.lower()
        if "idm-vton" in model_lower:
            return {
                "human_image_url": human_uri,
                "garment_image_url": garment_uri,
                "description": english_prompt,
                "category": FAL_IDM_CATEGORY_MAP[cloth_type],
                "num_inference_steps": 30,
            }
        if "leffa" in model_lower:
            return {
                "human_image_url": human_uri,
                "garment_image_url": garment_uri,
                "garment_type": FAL_IDM_CATEGORY_MAP[cloth_type],
                "num_inference_steps": 30,
            }
        # Default: fal-ai/cat-vton
        return {
            "human_image_url": human_uri,
            "garment_image_url": garment_uri,
            "cloth_type": FAL_CATVTON_CLOTH_MAP[cloth_type],
            "num_inference_steps": 30,
            "guidance_scale": 2.5,
        }

    @staticmethod
    def _extract_output_image_url(data: dict[str, Any]) -> str | None:
        if isinstance(data.get("image"), dict) and data["image"].get("url"):
            return str(data["image"]["url"])
        if isinstance(data.get("image_url"), str) and data["image_url"].strip():
            return data["image_url"].strip()
        images = data.get("images")
        if isinstance(images, list) and images:
            first = images[0]
            if isinstance(first, dict) and first.get("url"):
                return str(first["url"])
            if isinstance(first, str) and first.strip():
                return first.strip()
        output = data.get("output")
        if isinstance(output, dict):
            return FalCatVtonProvider._extract_output_image_url(output)
        return None

    async def synthesize(self, request: TryOnGenerationRequest) -> TryOnGenerationResult:
        if not self.fal_key:
            raise RuntimeError("FAL_KEY is not configured; cannot execute FalCatVtonProvider.")

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

        payload = self._build_payload(
            human_uri=self._to_data_uri(person_png, "image/png"),
            garment_uri=self._to_data_uri(garment_png, "image/png"),
            cloth_type=cloth_type,
            english_prompt=request.english_prompt,
        )
        headers = {
            "Authorization": f"Key {self.fal_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=httpx.Timeout(budget, connect=8.0)) as client:
            resp = await client.post(self.endpoint_url, json=payload, headers=headers)
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"fal.ai ({self.fal_vton_model}) HTTP {resp.status_code}: {resp.text[:240]}"
                )
            data: dict[str, Any] = resp.json()
            external_job_id = str(data.get("request_id") or data.get("id") or "fal-sync")
            image_url = self._extract_output_image_url(data)

            # Handle asynchronous queue.fal.run polling (`status_url` -> `response_url`)
            if not image_url:
                status_url = str(data.get("status_url") or "").strip()
                response_url = str(data.get("response_url") or "").strip()
                if not status_url and external_job_id != "fal-sync":
                    status_url = f"{self.endpoint_url}/requests/{external_job_id}/status"
                if not response_url and external_job_id != "fal-sync":
                    response_url = f"{self.endpoint_url}/requests/{external_job_id}"

                if not status_url or not response_url:
                    raise RuntimeError("fal.ai response did not include an output image URL or status_url.")

                while time.monotonic() < deadline:
                    st_resp = await client.get(status_url, headers=headers)
                    if st_resp.status_code >= 400:
                        raise RuntimeError(
                            f"fal.ai status poll HTTP {st_resp.status_code}: {st_resp.text[:200]}"
                        )
                    st_data = st_resp.json()
                    st_val = str(st_data.get("status") or "").upper()
                    if st_val == "COMPLETED":
                        res_resp = await client.get(response_url, headers=headers)
                        res_resp.raise_for_status()
                        res_data = res_resp.json()
                        image_url = self._extract_output_image_url(res_data)
                        break
                    if st_val in ("FAILED", "CANCELLED", "ERROR"):
                        raise RuntimeError(
                            f"fal.ai job {external_job_id} failed: {st_data.get('error') or st_val}"
                        )
                    await asyncio.sleep(min(1.0, max(0.25, deadline - time.monotonic())))

            if not image_url:
                raise TimeoutError(
                    f"fal.ai ({self.fal_vton_model}) timed out after {budget:.1f}s waiting for image."
                )

            img_resp = await client.get(image_url)
            img_resp.raise_for_status()
            normalized_bytes = await asyncio.to_thread(
                normalize_output_768x1024, img_resp.content, fmt="WEBP"
            )

        latency_ms = max(1, int((time.perf_counter() - started) * 1000))
        return TryOnGenerationResult(
            result_bytes=normalized_bytes,
            content_type="image/webp",
            provider_used="fal",
            provider_type="FAL_CATVTON",
            provider_badge=GENERATIVE_VTON_BADGE,
            latency_ms=latency_ms,
            clean_collar_applied=clean_collar,
            external_job_id=external_job_id,
            estimated_cost_usd=0.03,
            width=CANVAS_W,
            height=CANVAS_H,
            notes=f"Generated via fal.ai {self.fal_vton_model}.",
        )

    async def _generate_legacy_preview(self, request: VTONRequest) -> VTONResult:
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(minutes=self.purge_ttl_minutes)
        return VTONResult(
            job_id=f"fal_preview_{request.garment_sku_id}",
            provider=self.name,
            status="COMPLETED",
            result_bucket=self.private_bucket,
            result_object_key=f"previews/{request.user_id}/fal_preview.webp",
            preview_url=f"minio://{self.private_bucket}/previews/{request.user_id}/fal_preview.webp",
            aspect_ratio=request.aspect_ratio,
            latency_ms=0,
            created_at=now,
            expires_at=expires_at,
            notes=f"FalCatVtonProvider ({self.fal_vton_model}) active.",
        )

    async def health_check(self) -> bool:
        return bool(self.fal_key)


# Backwards-compatible alias
FalCatVTONProvider = FalCatVtonProvider
