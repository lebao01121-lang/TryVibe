from __future__ import annotations

import base64
import io
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from PIL import Image, ImageOps

from app.providers.base import (
    GENERATIVE_VTON_BADGE,
    ProviderCapabilities,
    VTONProviderType,
    VTONRenderStepResult,
    VTONRequest,
    VTONResult,
    VTONStepCategory,
)

FAL_CLOTH_TYPE_MAP: dict[VTONStepCategory, str] = {
    "UPPER": "upper",
    "LOWER": "lower",
    "OVERALL": "overall",
}


class FalCatVTONProvider:
    """Tier 1 Async fal.ai CatVTON provider adapter (45s timeout, 1-step & 2-step sequential)."""

    name: str = "fal"
    provider_type: VTONProviderType = "FAL_CATVTON"
    capabilities: ProviderCapabilities = ProviderCapabilities(
        name="fal",
        display_name="fal.ai CatVTON Cloud Adapter (Tier 1)",
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
        endpoint_url: str = "https://queue.fal.run/fal-ai/cat-vton",
        timeout_seconds: float = 45.0,
        private_bucket: str = "atelier-private-tryon",
        purge_ttl_minutes: int = 15,
    ) -> None:
        self.fal_key = fal_key.strip()
        self.endpoint_url = endpoint_url.strip()
        self.timeout_seconds = timeout_seconds
        self.private_bucket = private_bucket
        self.purge_ttl_minutes = purge_ttl_minutes

    @staticmethod
    def _to_data_uri(payload: bytes, mime: str = "image/webp") -> str:
        encoded = base64.b64encode(payload).decode("ascii")
        return f"data:{mime};base64,{encoded}"

    @staticmethod
    def _composite_garment_white(garment_bytes: bytes) -> bytes:
        with Image.open(io.BytesIO(garment_bytes)) as raw:
            im = ImageOps.exif_transpose(raw).convert("RGBA")
            fitted = ImageOps.contain(im, (704, 960), method=Image.Resampling.LANCZOS)
            bg = Image.new("RGBA", (768, 1024), (250, 250, 250, 255))
            bg.paste(fitted, ((768 - fitted.width) // 2, (1024 - fitted.height) // 2), fitted)
            out = io.BytesIO()
            bg.convert("RGB").save(out, format="WEBP", quality=92)
            return out.getvalue()

    async def render_step(
        self,
        *,
        person_image_bytes: bytes,
        garment_image_bytes: bytes | None,
        garment_image_url: str | None,
        garment_category: VTONStepCategory,
        garment_label: str = "",
        step_order: int = 1,
        total_steps: int = 1,
        pose_landmarks: dict[str, Any] | None = None,
    ) -> VTONRenderStepResult:
        del garment_label, step_order, total_steps, pose_landmarks
        if not self.fal_key:
            raise RuntimeError(
                "FAL_KEY is not configured; cannot execute FalCatVTONProvider."
            )

        started = time.perf_counter()
        human_input = self._to_data_uri(person_image_bytes, "image/webp")
        if garment_image_bytes:
            white_garment = self._composite_garment_white(garment_image_bytes)
            garment_input = self._to_data_uri(white_garment, "image/webp")
        elif garment_image_url and (
            garment_image_url.startswith("http://")
            or garment_image_url.startswith("https://")
        ):
            garment_input = garment_image_url
        else:
            raise RuntimeError("Garment image source is required for FalCatVTONProvider.")

        payload: dict[str, Any] = {
            "human_image_url": human_input,
            "garment_image_url": garment_input,
            "cloth_type": FAL_CLOTH_TYPE_MAP[garment_category],
            "num_inference_steps": 30,
            "guidance_scale": 2.5,
        }
        headers = {
            "Authorization": f"Key {self.fal_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            resp = await client.post(self.endpoint_url, json=payload, headers=headers)
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"fal.ai CatVTON returned HTTP {resp.status_code}: {resp.text[:240]}"
                )
            data = resp.json()
            external_job_id = str(data.get("request_id") or data.get("id") or "fal-sync")

            image_url = (
                (data.get("image") or {}).get("url")
                if isinstance(data.get("image"), dict)
                else data.get("image_url")
            )
            if not image_url:
                raise RuntimeError("fal.ai CatVTON response did not include an output image URL.")

            img_resp = await client.get(str(image_url))
            img_resp.raise_for_status()
            output_bytes = img_resp.content
            content_type = img_resp.headers.get("content-type", "image/png").split(";")[0].strip()

        latency_ms = max(1, int((time.perf_counter() - started) * 1000))
        return VTONRenderStepResult(
            image_bytes=output_bytes,
            content_type=content_type or "image/png",
            provider_type="FAL_CATVTON",
            provider_display_badge=GENERATIVE_VTON_BADGE,
            external_job_id=external_job_id,
            estimated_cost_usd=0.03,
            latency_ms=latency_ms,
            notes="Generated via fal.ai CatVTON.",
        )

    async def generate(self, request: VTONRequest) -> VTONResult:
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
            notes="FalCatVTONProvider active for async session rendering.",
        )

    async def health_check(self) -> bool:
        return bool(self.fal_key)
