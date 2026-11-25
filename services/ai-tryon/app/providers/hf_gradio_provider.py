from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import os
import shutil
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.config import DEFAULT_TRYON_TMP_DIR, bootstrap_d_drive_environment
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
from app.providers.circuit_breaker import ProviderCircuitBreaker, is_quota_or_fatal_error
from app.providers.photometric_inpaint_provider import (
    CANVAS_H,
    CANVAS_W,
    composite_garment_studio_white,
    normalize_output_768x1024,
    resolve_bytes_or_url,
)

# Guarantee D: drive isolation before gradio_client initializes
bootstrap_d_drive_environment()

logger = logging.getLogger("atelier.ai_tryon.hf_gradio")

# Exact fallback order specified for Stage 2 ZeroGPU Diffusion
HF_VTON_SPACES: tuple[str, ...] = (
    "zhengchong/CatVTON",
    "yisol/IDM-VTON",
    "Kwai-Kolors/Kolors-Virtual-Try-On",
)

IDM_CATEGORY_MAP: dict[ClothType, str] = {
    "upper": "upper_body",
    "outerwear": "upper_body",
    "lower": "lower_body",
    "overall": "dresses",
}

CATVTON_CATEGORY_MAP: dict[ClothType, str] = {
    "upper": "upper",
    "outerwear": "upper",
    "lower": "lower",
    "overall": "overall",
}


def _normalize_person_png(person_bytes: bytes) -> bytes:
    canvas = normalize_user_portrait_3x4(person_bytes, target_size=(CANVAS_W, CANVAS_H))
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
    cloth_type: ClothType,
    english_prompt: str,
    hf_token: str,
    download_dir: str,
    per_space_timeout: float = 12.0,
) -> bytes:
    # Ensure temp vars remain locked to D: drive inside worker thread
    bootstrap_d_drive_environment()

    from gradio_client import Client, handle_file

    client_kwargs: dict[str, Any] = {
        "verbose": False,
        "download_files": download_dir,
        "httpx_kwargs": {"timeout": min(6.0, per_space_timeout)},
    }
    if hf_token:
        client_kwargs["token"] = hf_token

    try:
        client = Client(space_id, **client_kwargs)
    except TypeError:
        client_kwargs.pop("token", None)
        if hf_token:
            client_kwargs["hf_token"] = hf_token
        client = Client(space_id, **client_kwargs)

    human_file = handle_file(human_path)
    garment_file = handle_file(garment_path)
    desc = english_prompt or f"tailored luxury {IDM_CATEGORY_MAP[cloth_type].replace('_', ' ')}"

    job = None
    result_path: str | None = None
    try:
        if space_id == "zhengchong/CatVTON":
            job = client.submit(
                person_image={"background": human_file, "layers": [], "composite": None},
                cloth_image=garment_file,
                cloth_type=CATVTON_CATEGORY_MAP[cloth_type],
                num_inference_steps=25,
                guidance_scale=2.5,
                seed=42,
                show_type="result only",
                api_name="/submit_function",
            )
        elif space_id == "yisol/IDM-VTON":
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

        raw_out = job.result(timeout=max(4.0, per_space_timeout - 1.5))
        result_path = _extract_result_path(raw_out)
        if not result_path or not Path(result_path).exists():
            raise RuntimeError(f"HF Space '{space_id}' returned no readable output image path.")

        raw_bytes = Path(result_path).read_bytes()
        return normalize_output_768x1024(raw_bytes, fmt="WEBP")
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
        # Immediately unlink downloaded Gradio output file so ZERO personal images linger on disk
        if result_path:
            try:
                rp = Path(result_path)
                if rp.is_file():
                    rp.unlink(missing_ok=True)
            except Exception:
                pass


class HuggingFaceZeroGpuVtonProvider(BaseVtonProvider):
    """
    Tier 2 Generative Diffusion VTON via HuggingFace ZeroGPU Spaces (`$0`):
      - Fallback chain: `zhengchong/CatVTON` -> `yisol/IDM-VTON` -> `Kwai-Kolors/Kolors-Virtual-Try-On`
      - Per-space Circuit Breaker (`180s` cooldown on quota exhaustion / timeout / errors)
      - 100% D: drive temp isolation (`download_files` + `mkdtemp` inside `.project-data/tmp`)
      - Guaranteed `finally:` immediate unlink & cleanup of all temp files after reading bytes
    """

    name: str = "hf_gradio"
    provider_type: VTONProviderType = "HF_GRADIO_VTON"
    capabilities: ProviderCapabilities = ProviderCapabilities(
        name="hf_gradio",
        display_name="HuggingFace ZeroGPU Generative VTON (CatVTON / IDM-VTON / Kolors · Tier 2)",
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
        timeout_seconds: float = 28.0,
        enabled: bool = True,
        spaces: tuple[str, ...] = HF_VTON_SPACES,
        circuit_breaker: ProviderCircuitBreaker | None = None,
        tmp_dir: str | Path | None = None,
        private_bucket: str = "atelier-private-tryon",
        purge_ttl_minutes: int = 15,
    ) -> None:
        self.hf_token = (hf_token or "").strip()
        self.timeout_seconds = max(5.0, float(timeout_seconds))
        self.enabled = bool(enabled)
        self.spaces = spaces
        self.circuit_breaker = circuit_breaker or ProviderCircuitBreaker(cooldown_seconds=180.0)
        resolved_tmp, _ = bootstrap_d_drive_environment(tmp_dir=tmp_dir or DEFAULT_TRYON_TMP_DIR)
        self.tmp_dir = resolved_tmp
        self.private_bucket = private_bucket
        self.purge_ttl_minutes = purge_ttl_minutes

    def _space_cb_key(self, space_id: str) -> str:
        return f"hf:{space_id.lower()}"

    async def _run_spaces_chain(
        self,
        *,
        person_bytes: bytes,
        garment_bytes: bytes,
        cloth_type: ClothType,
        color_hex: str | None,
        english_prompt: str,
        budget_seconds: float,
    ) -> tuple[bytes, str, bool]:
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + budget_seconds
        last_errors: list[str] = []

        # Fast-check: skip disk I/O completely if EVERY Space circuit breaker is already OPEN!
        available_spaces = [
            sp for sp in self.spaces if self.circuit_breaker.allow_request(self._space_cb_key(sp))
        ]
        if not available_spaces:
            raise RuntimeError(
                "All HF ZeroGPU VTON Spaces are currently in circuit-breaker cooldown (180s)."
            )

        work_dir = Path(tempfile.mkdtemp(prefix="hf_vton_", dir=str(self.tmp_dir)))
        human_file = work_dir / "human.png"
        garment_file = work_dir / "garment.png"
        dl_dir = work_dir / "out"

        try:
            dl_dir.mkdir(parents=True, exist_ok=True)
            person_png = await asyncio.to_thread(_normalize_person_png, person_bytes)
            garment_png, clean_collar = await asyncio.to_thread(
                composite_garment_studio_white,
                garment_bytes,
                cloth_type=cloth_type,
                color_hex=color_hex,
                output_format="PNG",
            )
            human_file.write_bytes(person_png)
            garment_file.write_bytes(garment_png)

            for idx, space_id in enumerate(available_spaces):
                cb_key = self._space_cb_key(space_id)
                remaining = deadline - time.monotonic()
                if remaining <= 2.5:
                    last_errors.append(f"{space_id}: overall budget exhausted")
                    break

                spaces_left = max(1, len(available_spaces) - idx)
                per_space_cap = min(remaining, max(7.5, min(11.5, remaining / spaces_left + 2.5)))

                try:
                    output_bytes = await asyncio.wait_for(
                        asyncio.to_thread(
                            _call_single_space_sync,
                            space_id=space_id,
                            human_path=str(human_file),
                            garment_path=str(garment_file),
                            cloth_type=cloth_type,
                            english_prompt=english_prompt,
                            hf_token=self.hf_token,
                            download_dir=str(dl_dir),
                            per_space_timeout=per_space_cap,
                        ),
                        timeout=per_space_cap,
                    )
                    if output_bytes and len(output_bytes) > 2000:
                        self.circuit_breaker.record_success(cb_key)
                        return output_bytes, space_id, clean_collar

                    msg = f"{space_id}: empty image output"
                    self.circuit_breaker.record_failure(cb_key, msg)
                    last_errors.append(msg)
                except asyncio.TimeoutError:
                    msg = f"{space_id}: timed out after {per_space_cap:.1f}s"
                    logger.warning("HF ZeroGPU VTON timeout: %s", msg)
                    self.circuit_breaker.record_failure(cb_key, msg, trip_immediately=True)
                    last_errors.append(msg)
                except Exception as exc:
                    msg = f"{space_id}: {exc.__class__.__name__}: {str(exc)[:180]}"
                    logger.warning("HF ZeroGPU VTON failed: %s", msg)
                    self.circuit_breaker.record_failure(
                        cb_key,
                        msg,
                        trip_immediately=is_quota_or_fatal_error(exc),
                    )
                    last_errors.append(msg)
        finally:
            # Mandatory immediate cleanup of ALL temp input/download files on D: drive
            for p in (human_file, garment_file):
                try:
                    if p.exists():
                        p.unlink(missing_ok=True)
                except Exception:
                    pass
            try:
                if dl_dir.exists():
                    for root, _, files in os.walk(dl_dir):
                        for fname in files:
                            try:
                                (Path(root) / fname).unlink(missing_ok=True)
                            except Exception:
                                pass
                shutil.rmtree(work_dir, ignore_errors=True)
            except Exception:
                pass

        raise RuntimeError("All HF ZeroGPU VTON Spaces unavailable: " + " | ".join(last_errors))

    async def synthesize(self, request: TryOnGenerationRequest) -> TryOnGenerationResult:
        if not self.enabled:
            raise RuntimeError("HuggingFaceZeroGpuVtonProvider is disabled via HF_VTON_ENABLED=false.")

        started = time.perf_counter()
        budget = min(self.timeout_seconds, float(request.timeout_seconds or self.timeout_seconds))

        person_bytes = await resolve_bytes_or_url(request.person_bytes, request.human_image_url)
        garment_bytes = await resolve_bytes_or_url(request.garment_bytes, request.garment_image_url)

        output_bytes, used_space, clean_collar = await asyncio.wait_for(
            self._run_spaces_chain(
                person_bytes=person_bytes,
                garment_bytes=garment_bytes,
                cloth_type=request.normalized_cloth_type,
                color_hex=request.color_hex,
                english_prompt=request.english_prompt,
                budget_seconds=budget,
            ),
            timeout=budget + 1.0,
        )

        latency_ms = max(1, int((time.perf_counter() - started) * 1000))
        digest = hashlib.sha256(output_bytes[:4096]).hexdigest()[:12]
        safe_space = used_space.replace("/", "_").lower()
        return TryOnGenerationResult(
            result_bytes=output_bytes,
            content_type="image/webp",
            provider_used="catvton",
            provider_type="HF_GRADIO_VTON",
            provider_badge=GENERATIVE_VTON_BADGE,
            latency_ms=latency_ms,
            clean_collar_applied=clean_collar,
            external_job_id=f"hf_{safe_space}_{digest}",
            estimated_cost_usd=0.0,
            width=CANVAS_W,
            height=CANVAS_H,
            notes=f"Generated via HuggingFace ZeroGPU Space {used_space}.",
        )

    async def _generate_legacy_preview(self, request: VTONRequest) -> VTONResult:
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
            notes="HuggingFaceZeroGpuVtonProvider active.",
        )

    async def health_check(self) -> bool:
        return self.enabled


# Backwards-compatible alias
HuggingFaceGradioVTONProvider = HuggingFaceZeroGpuVtonProvider
