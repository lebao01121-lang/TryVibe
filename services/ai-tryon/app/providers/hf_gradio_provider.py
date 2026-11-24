from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

from app.preprocessing.normalizer import normalize_user_portrait_3x4
from app.providers.base import (
    GENERATIVE_VTON_BADGE,
    ProviderCapabilities,
    VTONProviderType,
    VTONRenderStepResult,
    VTONRequest,
    VTONResult,
    VTONStepCategory,
)

logger = logging.getLogger("atelier.ai_tryon.hf_gradio")

HF_VTON_SPACES: tuple[str, ...] = (
    "yisol/IDM-VTON",
    "zhengchong/CatVTON",
    "Kwai-Kolors/Kolors-Virtual-Try-On",
)

IDM_CATEGORY_MAP: dict[VTONStepCategory, str] = {
    "UPPER": "upper_body",
    "LOWER": "lower_body",
    "OVERALL": "dresses",
}

CATVTON_CATEGORY_MAP: dict[VTONStepCategory, str] = {
    "UPPER": "upper",
    "LOWER": "lower",
    "OVERALL": "overall",
}

# Store short-lived Gradio temp files under workspace (D:) rather than potentially full C:\Temp
SERVICE_TMP_ROOT = Path(__file__).resolve().parents[2] / ".tmp_vton"


def _composite_garment_on_studio_white(garment_bytes: bytes) -> bytes:
    """Composite RGBA garment onto crisp #FAFAFA studio white for generative diffusion VTON."""
    with Image.open(io.BytesIO(garment_bytes)) as raw:
        im = ImageOps.exif_transpose(raw).convert("RGBA")
        fitted = ImageOps.contain(im, (704, 960), method=Image.Resampling.LANCZOS)
        bg = Image.new("RGBA", (768, 1024), (250, 250, 250, 255))
        bg.paste(fitted, ((768 - fitted.width) // 2, (1024 - fitted.height) // 2), fitted)
        out = io.BytesIO()
        bg.convert("RGB").save(out, format="PNG")
        return out.getvalue()


def _normalize_person_png(person_bytes: bytes) -> bytes:
    canvas = normalize_user_portrait_3x4(person_bytes, target_size=(768, 1024))
    out = io.BytesIO()
    canvas.convert("RGB").save(out, format="PNG")
    return out.getvalue()


def _extract_result_path(result: Any) -> str | None:
    """Extract output image filepath from varied Gradio return payloads (str, tuple, dict)."""
    if isinstance(result, str) and result.strip():
        return result.strip()
    if isinstance(result, dict):
        for key in ("path", "image", "url", "value"):
            val = result.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    if isinstance(result, (list, tuple)):
        for item in result:
            found = _extract_result_path(item)
            if found:
                return found
    return None


def _call_single_space_sync(
    *,
    space_id: str,
    human_path: str,
    garment_path: str,
    garment_category: VTONStepCategory,
    garment_label: str,
    hf_token: str,
    download_dir: str,
    per_space_timeout: float = 12.0,
) -> bytes:
    from gradio_client import Client, handle_file

    client_kwargs: dict[str, Any] = {
        "verbose": False,
        "download_files": download_dir,
        "httpx_kwargs": {"timeout": min(8.0, per_space_timeout)},
    }
    if hf_token:
        client_kwargs["token"] = hf_token

    try:
        client = Client(space_id, **client_kwargs)
    except TypeError:
        # Backward compatibility if older gradio_client expects `hf_token`
        client_kwargs.pop("token", None)
        if hf_token:
            client_kwargs["hf_token"] = hf_token
        client = Client(space_id, **client_kwargs)

    human_file = handle_file(human_path)
    garment_file = handle_file(garment_path)
    desc = garment_label or f"tailored luxury {IDM_CATEGORY_MAP[garment_category].replace('_', ' ')}"

    job = None
    try:
        if space_id == "yisol/IDM-VTON":
            job = client.submit(
                dict={"background": human_file, "layers": [], "composite": None},
                garm_img=garment_file,
                garment_des=desc,
                is_checked=True,
                is_checked_crop=False,
                denoise_steps=20,
                seed=42,
                api_name="/tryon",
            )
        elif space_id == "zhengchong/CatVTON":
            job = client.submit(
                person_image={"background": human_file, "layers": [], "composite": None},
                cloth_image=garment_file,
                cloth_type=CATVTON_CATEGORY_MAP[garment_category],
                num_inference_steps=25,
                guidance_scale=2.5,
                seed=42,
                show_type="result only",
                api_name="/submit_function",
            )
        else:
            # Kwai-Kolors/Kolors-Virtual-Try-On
            try:
                job = client.submit(
                    person_img=human_file,
                    garment_img=garment_file,
                    seed=0,
                    randomize_seed=False,
                    api_name="/tryon",
                )
            except Exception:
                job = client.submit(
                    human_file,
                    garment_file,
                    0,
                    False,
                    fn_index=0,
                )

        raw_out = job.result(timeout=max(4.0, per_space_timeout - 2.0))
    finally:
        if job is not None:
            try:
                job.cancel()
            except Exception:
                pass
        try:
            client.close()
        except Exception:
            pass

    result_path = _extract_result_path(raw_out)
    if not result_path or not Path(result_path).exists():
        raise RuntimeError(f"HF Space '{space_id}' returned no readable output image path.")

    with Image.open(result_path) as out_im:
        fitted = ImageOps.fit(
            out_im.convert("RGB"),
            (768, 1024),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )
        buf = io.BytesIO()
        fitted.save(buf, format="WEBP", quality=91, method=4)
        return buf.getvalue()


class HuggingFaceGradioVTONProvider:
    """
    Tier 2 Generative VTON via HuggingFace Spaces (gradio_client).
    Tries yisol/IDM-VTON -> zhengchong/CatVTON -> Kwai-Kolors/Kolors-Virtual-Try-On
    under strict overall and per-space timeouts so workers never stall.
    """

    name: str = "hf_gradio"
    provider_type: VTONProviderType = "HF_GRADIO_VTON"
    capabilities: ProviderCapabilities = ProviderCapabilities(
        name="hf_gradio",
        display_name="HuggingFace Gradio Generative VTON (IDM-VTON / CatVTON / Kolors)",
        mode="remote-api",
        supported_categories=("TOP", "BOTTOM", "ONE_PIECE", "OUTERWEAR"),
        supported_aspect_ratios=("3:4", "2:3"),
        supports_alpha_cutout=True,
        status="active",
    )

    def __init__(
        self,
        *,
        hf_token: str = "",
        timeout_seconds: float = 40.0,
        enabled: bool = True,
        spaces: tuple[str, ...] = HF_VTON_SPACES,
        private_bucket: str = "atelier-private-tryon",
        purge_ttl_minutes: int = 15,
    ) -> None:
        self.hf_token = (hf_token or "").strip()
        self.timeout_seconds = max(5.0, float(timeout_seconds))
        self.enabled = bool(enabled)
        self.spaces = spaces
        self.private_bucket = private_bucket
        self.purge_ttl_minutes = purge_ttl_minutes

    async def _run_spaces_chain(
        self,
        *,
        person_image_bytes: bytes,
        garment_image_bytes: bytes,
        garment_category: VTONStepCategory,
        garment_label: str,
    ) -> tuple[bytes, str]:
        SERVICE_TMP_ROOT.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self.timeout_seconds
        last_errors: list[str] = []

        with tempfile.TemporaryDirectory(dir=str(SERVICE_TMP_ROOT), prefix="hf_") as tmp_dir:
            tmp_path = Path(tmp_dir)
            human_file = tmp_path / "human.png"
            garment_file = tmp_path / "garment.png"
            dl_dir = tmp_path / "out"
            dl_dir.mkdir(exist_ok=True)

            human_png = await asyncio.to_thread(_normalize_person_png, person_image_bytes)
            garment_png = await asyncio.to_thread(
                _composite_garment_on_studio_white, garment_image_bytes
            )
            human_file.write_bytes(human_png)
            garment_file.write_bytes(garment_png)

            for idx, space_id in enumerate(self.spaces):
                remaining = deadline - time.monotonic()
                if remaining <= 2.5:
                    last_errors.append(f"{space_id}: overall budget exhausted")
                    break

                # Cap per-space call so an unresponsive Space leaves budget for remaining Spaces
                spaces_left = max(1, len(self.spaces) - idx)
                per_space_cap = min(remaining, max(10.0, min(16.0, remaining / spaces_left + 4.0)))

                try:
                    output_bytes = await asyncio.wait_for(
                        asyncio.to_thread(
                            _call_single_space_sync,
                            space_id=space_id,
                            human_path=str(human_file),
                            garment_path=str(garment_file),
                            garment_category=garment_category,
                            garment_label=garment_label,
                            hf_token=self.hf_token,
                            download_dir=str(dl_dir),
                            per_space_timeout=per_space_cap,
                        ),
                        timeout=per_space_cap,
                    )
                    if output_bytes and len(output_bytes) > 2000:
                        return output_bytes, space_id
                    last_errors.append(f"{space_id}: empty image output")
                except asyncio.TimeoutError:
                    msg = f"{space_id}: timed out after {per_space_cap:.1f}s"
                    logger.warning("HF Gradio VTON space timeout: %s", msg)
                    last_errors.append(msg)
                except Exception as exc:
                    msg = f"{space_id}: {exc.__class__.__name__}: {str(exc)[:180]}"
                    logger.warning("HF Gradio VTON space failed: %s", msg)
                    last_errors.append(msg)

        raise RuntimeError("All HF Gradio VTON Spaces unavailable: " + " | ".join(last_errors))

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
        del garment_image_url, step_order, total_steps, pose_landmarks
        if not self.enabled:
            raise RuntimeError("HuggingFaceGradioVTONProvider is disabled via HF_VTON_ENABLED=false.")
        if not garment_image_bytes:
            raise RuntimeError("Garment RGBA bytes are required for HuggingFaceGradioVTONProvider.")

        started = time.perf_counter()
        output_bytes, used_space = await asyncio.wait_for(
            self._run_spaces_chain(
                person_image_bytes=person_image_bytes,
                garment_image_bytes=garment_image_bytes,
                garment_category=garment_category,
                garment_label=garment_label,
            ),
            timeout=self.timeout_seconds,
        )
        latency_ms = max(1, int((time.perf_counter() - started) * 1000))
        digest = hashlib.sha256(output_bytes[:4096]).hexdigest()[:12]
        safe_space = used_space.replace("/", "_").lower()
        return VTONRenderStepResult(
            image_bytes=output_bytes,
            content_type="image/webp",
            provider_type="HF_GRADIO_VTON",
            provider_display_badge=GENERATIVE_VTON_BADGE,
            external_job_id=f"hf_{safe_space}_{digest}",
            estimated_cost_usd=0.0,
            latency_ms=latency_ms,
            notes=f"Generated via HuggingFace Space {used_space}.",
        )

    async def generate(self, request: VTONRequest) -> VTONResult:
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(minutes=self.purge_ttl_minutes)
        return VTONResult(
            job_id=f"hf_preview_{request.garment_sku_id}",
            provider=self.name,
            status="COMPLETED",
            result_bucket=self.private_bucket,
            result_object_key=f"previews/{request.user_id}/hf_preview.webp",
            preview_url=f"minio://{self.private_bucket}/previews/{request.user_id}/hf_preview.webp",
            aspect_ratio=request.aspect_ratio,
            latency_ms=0,
            created_at=now,
            expires_at=expires_at,
            notes="HuggingFaceGradioVTONProvider active.",
        )

    async def health_check(self) -> bool:
        return self.enabled
