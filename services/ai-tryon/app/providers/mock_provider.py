from __future__ import annotations

from pathlib import Path
from typing import Any

from app.config import get_settings
from app.providers.auto_provider import CompositeVtonRouter
from app.providers.base import (
    PHOTOMETRIC_INPAINT_BADGE,
    BaseVtonProvider,
    ProviderCapabilities,
    TryOnGenerationRequest,
    TryOnGenerationResult,
    VTONProvider,
    VTONProviderType,
    VTONRequest,
    VTONResult,
)
from app.providers.circuit_breaker import ProviderCircuitBreaker
from app.providers.fal_provider import FalCatVtonProvider
from app.providers.fashn_provider import FashnVtonProvider
from app.providers.hf_gradio_provider import HuggingFaceZeroGpuVtonProvider
from app.providers.local_gpu_provider import LocalGpuVtonProvider
from app.providers.photometric_inpaint_provider import PhotometricInpaintWarpProvider


class MockVTONProvider(BaseVtonProvider):
    """
    Backward-compatible adapter delegating to Tier 4 `PhotometricInpaintWarpProvider`.
    NEVER uses legacy polygon placeholders or face-overwriting static overlays.
    """

    name: str = "mock"
    provider_type: VTONProviderType = "PHOTOMETRIC_INPAINT"
    capabilities: ProviderCapabilities = ProviderCapabilities(
        name="mock",
        display_name="Atelier Photometric Inpaint & TPS Engine ($0 · Immortal Fallback)",
        mode="local-cv",
        supported_categories=("TOP", "BOTTOM", "ONE_PIECE", "OUTERWEAR"),
        supported_aspect_ratios=("2:3", "3:4"),
        supports_alpha_cutout=True,
        status="active",
    )

    def __init__(
        self,
        *,
        private_bucket: str = "atelier-private-tryon",
        purge_ttl_minutes: int = 15,
        step_delay_seconds: float = 0.0,
    ) -> None:
        del step_delay_seconds
        self.private_bucket = private_bucket
        self.purge_ttl_minutes = purge_ttl_minutes
        self._delegate = PhotometricInpaintWarpProvider(
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )

    async def synthesize(self, request: TryOnGenerationRequest) -> TryOnGenerationResult:
        res = await self._delegate.synthesize(request)
        return TryOnGenerationResult(
            result_bytes=res.result_bytes,
            content_type=res.content_type,
            provider_used=res.provider_used,
            provider_type=res.provider_type,
            provider_badge=res.provider_badge or PHOTOMETRIC_INPAINT_BADGE,
            latency_ms=res.latency_ms,
            clean_collar_applied=res.clean_collar_applied,
            external_job_id=res.external_job_id,
            estimated_cost_usd=0.0,
            width=res.width,
            height=res.height,
            notes=res.notes,
        )

    async def _generate_legacy_preview(self, request: VTONRequest) -> VTONResult:
        return await self._delegate._generate_legacy_preview(request)

    async def health_check(self) -> bool:
        return True


def list_registered_providers(active_provider: str = "auto") -> list[dict[str, Any]]:
    """Return catalog of all 4-tier VTON provider adapters."""
    normalized = (active_provider or "auto").strip().lower()
    return [
        {
            "name": CompositeVtonRouter.name,
            "providerType": "PHOTOMETRIC_INPAINT",
            "displayName": CompositeVtonRouter.capabilities.display_name,
            "mode": CompositeVtonRouter.capabilities.mode,
            "active": normalized == "auto",
            "status": "active",
            "supportedCategories": list(CompositeVtonRouter.capabilities.supported_categories),
            "supportedAspectRatios": list(CompositeVtonRouter.capabilities.supported_aspect_ratios),
            "supportsAlphaCutout": True,
        },
        {
            "name": FalCatVtonProvider.name,
            "providerType": "FAL_CATVTON",
            "displayName": FalCatVtonProvider.capabilities.display_name,
            "mode": FalCatVtonProvider.capabilities.mode,
            "active": normalized in ("fal", "fal_catvton", "catvton"),
            "status": "active",
            "supportedCategories": list(FalCatVtonProvider.capabilities.supported_categories),
            "supportedAspectRatios": list(FalCatVtonProvider.capabilities.supported_aspect_ratios),
            "supportsAlphaCutout": True,
        },
        {
            "name": FashnVtonProvider.name,
            "providerType": "FASHN_VTON",
            "displayName": FashnVtonProvider.capabilities.display_name,
            "mode": FashnVtonProvider.capabilities.mode,
            "active": normalized in ("fashn", "fashn_vton"),
            "status": "active",
            "supportedCategories": list(FashnVtonProvider.capabilities.supported_categories),
            "supportedAspectRatios": list(FashnVtonProvider.capabilities.supported_aspect_ratios),
            "supportsAlphaCutout": True,
        },
        {
            "name": LocalGpuVtonProvider.name,
            "providerType": "LOCAL_GPU_VTON",
            "displayName": LocalGpuVtonProvider.capabilities.display_name,
            "mode": LocalGpuVtonProvider.capabilities.mode,
            "active": normalized in ("local_gpu", "local_gpu_vton", "lan"),
            "status": "active",
            "supportedCategories": list(LocalGpuVtonProvider.capabilities.supported_categories),
            "supportedAspectRatios": list(LocalGpuVtonProvider.capabilities.supported_aspect_ratios),
            "supportsAlphaCutout": True,
        },
        {
            "name": HuggingFaceZeroGpuVtonProvider.name,
            "providerType": "HF_GRADIO_VTON",
            "displayName": HuggingFaceZeroGpuVtonProvider.capabilities.display_name,
            "mode": HuggingFaceZeroGpuVtonProvider.capabilities.mode,
            "active": normalized in ("hf", "hf_gradio", "hf_gradio_vton"),
            "status": "active",
            "supportedCategories": list(
                HuggingFaceZeroGpuVtonProvider.capabilities.supported_categories
            ),
            "supportedAspectRatios": list(
                HuggingFaceZeroGpuVtonProvider.capabilities.supported_aspect_ratios
            ),
            "supportsAlphaCutout": True,
        },
        {
            "name": PhotometricInpaintWarpProvider.name,
            "providerType": "PHOTOMETRIC_INPAINT",
            "displayName": PhotometricInpaintWarpProvider.capabilities.display_name,
            "mode": PhotometricInpaintWarpProvider.capabilities.mode,
            "active": normalized
            in ("photometric", "photometric_inpaint", "pose_warp", "smart_pose_warp", "mock"),
            "status": "active",
            "supportedCategories": list(
                PhotometricInpaintWarpProvider.capabilities.supported_categories
            ),
            "supportedAspectRatios": list(
                PhotometricInpaintWarpProvider.capabilities.supported_aspect_ratios
            ),
            "supportsAlphaCutout": True,
        },
    ]


def get_vton_provider(
    provider_name: str = "auto",
    *,
    private_bucket: str = "atelier-private-tryon",
    purge_ttl_minutes: int = 15,
    fal_key: str = "",
    fal_vton_model: str | None = None,
    fal_catvton_url: str | None = None,
    fal_timeout_seconds: float = 45.0,
    fashn_api_key: str | None = None,
    fashn_api_url: str | None = None,
    hf_token: str = "",
    hf_vton_timeout_seconds: float | None = None,
    hf_vton_enabled: bool = True,
    local_vton_endpoint: str | None = None,
    total_timeout_seconds: float | None = None,
    circuit_breaker_seconds: int | None = None,
    tmp_dir: str | Path | None = None,
) -> VTONProvider:
    """
    Resolve configured 4-tier VTON provider (100% backwards-compatible with Stage 1 calls):
      - `auto` (default): `CompositeVtonRouter` (Fal -> Fashn -> LAN GPU -> HF ZeroGPU -> PhotometricInpaint)
      - `fal` / `fal_catvton` / `catvton`: FalCatVtonProvider -> Tier 4 fallback
      - `fashn` / `fashn_vton`: FashnVtonProvider -> Tier 4 fallback
      - `local_gpu`: LocalGpuVtonProvider -> Tier 4 fallback
      - `hf_gradio` / `hf`: HuggingFaceZeroGpuVtonProvider -> Tier 4 fallback
      - `photometric_inpaint` / `pose_warp` / `smart_pose_warp` / `mock`: PhotometricInpaintWarpProvider
    """
    cfg = get_settings()
    resolved_fal_key = fal_key if fal_key else cfg.fal_key
    resolved_fal_model = fal_vton_model if fal_vton_model is not None else cfg.fal_vton_model
    resolved_fal_url = (
        fal_catvton_url if fal_catvton_url is not None else cfg.resolved_fal_endpoint_url
    )
    resolved_fashn_key = fashn_api_key if fashn_api_key is not None else cfg.fashn_api_key
    resolved_fashn_url = fashn_api_url if fashn_api_url is not None else cfg.fashn_api_url
    resolved_hf_token = hf_token if hf_token else cfg.hf_token
    resolved_hf_timeout = (
        hf_vton_timeout_seconds
        if hf_vton_timeout_seconds is not None
        else cfg.hf_vton_timeout_seconds
    )
    resolved_local_endpoint = (
        local_vton_endpoint if local_vton_endpoint is not None else cfg.local_vton_endpoint
    )
    resolved_total_timeout = (
        total_timeout_seconds
        if total_timeout_seconds is not None
        else cfg.tryon_total_timeout_seconds
    )
    resolved_cb_seconds = (
        circuit_breaker_seconds
        if circuit_breaker_seconds is not None
        else cfg.tryon_circuit_breaker_seconds
    )
    resolved_tmp_dir = tmp_dir if tmp_dir is not None else cfg.tryon_tmp_dir

    normalized = (provider_name or "auto").strip().lower()
    cb = ProviderCircuitBreaker(cooldown_seconds=float(resolved_cb_seconds), failure_threshold=2)

    tier4 = PhotometricInpaintWarpProvider(
        private_bucket=private_bucket,
        purge_ttl_minutes=purge_ttl_minutes,
    )

    if normalized in ("photometric", "photometric_inpaint", "pose_warp", "smart_pose_warp", "mock"):
        return tier4

    if normalized in ("fal", "fal_catvton", "catvton"):
        fal = FalCatVtonProvider(
            fal_key=resolved_fal_key,
            fal_vton_model=resolved_fal_model,
            endpoint_url=resolved_fal_url,
            timeout_seconds=fal_timeout_seconds,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )
        return CompositeVtonRouter(
            fal_provider=fal,
            photometric_provider=tier4,
            circuit_breaker=cb,
            total_timeout_seconds=resolved_total_timeout,
            circuit_breaker_seconds=resolved_cb_seconds,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )

    if normalized in ("fashn", "fashn_vton"):
        fashn = FashnVtonProvider(
            api_key=resolved_fashn_key,
            api_url=resolved_fashn_url,
            timeout_seconds=fal_timeout_seconds,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )
        return CompositeVtonRouter(
            fashn_provider=fashn,
            photometric_provider=tier4,
            circuit_breaker=cb,
            total_timeout_seconds=resolved_total_timeout,
            circuit_breaker_seconds=resolved_cb_seconds,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )

    if normalized in ("local_gpu", "local_gpu_vton", "lan"):
        local_gpu = LocalGpuVtonProvider(
            endpoint_url=resolved_local_endpoint,
            timeout_seconds=min(35.0, resolved_total_timeout),
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )
        return CompositeVtonRouter(
            local_gpu_provider=local_gpu,
            photometric_provider=tier4,
            circuit_breaker=cb,
            total_timeout_seconds=resolved_total_timeout,
            circuit_breaker_seconds=resolved_cb_seconds,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )

    if normalized in ("hf", "hf_gradio", "hf_gradio_vton"):
        hf = HuggingFaceZeroGpuVtonProvider(
            hf_token=resolved_hf_token,
            timeout_seconds=resolved_hf_timeout,
            enabled=hf_vton_enabled,
            circuit_breaker=cb,
            tmp_dir=resolved_tmp_dir,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )
        return CompositeVtonRouter(
            hf_provider=hf,
            photometric_provider=tier4,
            circuit_breaker=cb,
            total_timeout_seconds=resolved_total_timeout,
            circuit_breaker_seconds=resolved_cb_seconds,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )

    # Default "auto": Full 4-Tier CompositeVtonRouter
    fal_tier = (
        FalCatVtonProvider(
            fal_key=resolved_fal_key,
            fal_vton_model=resolved_fal_model,
            endpoint_url=resolved_fal_url,
            timeout_seconds=fal_timeout_seconds,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )
        if (resolved_fal_key or "").strip()
        else None
    )
    fashn_tier = (
        FashnVtonProvider(
            api_key=resolved_fashn_key,
            api_url=resolved_fashn_url,
            timeout_seconds=fal_timeout_seconds,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )
        if (resolved_fashn_key or "").strip()
        else None
    )
    local_gpu_tier = (
        LocalGpuVtonProvider(
            endpoint_url=resolved_local_endpoint,
            timeout_seconds=min(35.0, resolved_total_timeout),
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )
        if (resolved_local_endpoint or "").strip()
        else None
    )
    hf_tier = (
        HuggingFaceZeroGpuVtonProvider(
            hf_token=resolved_hf_token,
            timeout_seconds=resolved_hf_timeout,
            enabled=hf_vton_enabled,
            circuit_breaker=cb,
            tmp_dir=resolved_tmp_dir,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )
        if hf_vton_enabled
        else None
    )

    return CompositeVtonRouter(
        fal_provider=fal_tier,
        fashn_provider=fashn_tier,
        local_gpu_provider=local_gpu_tier,
        hf_provider=hf_tier,
        photometric_provider=tier4,
        circuit_breaker=cb,
        total_timeout_seconds=resolved_total_timeout,
        circuit_breaker_seconds=resolved_cb_seconds,
        private_bucket=private_bucket,
        purge_ttl_minutes=purge_ttl_minutes,
    )
