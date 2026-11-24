from __future__ import annotations

from typing import Any

from app.providers.auto_provider import AutoVTONProvider
from app.providers.base import (
    POSE_WARP_BADGE,
    ProviderCapabilities,
    VTONProvider,
    VTONProviderType,
    VTONRenderStepResult,
    VTONRequest,
    VTONResult,
    VTONStepCategory,
)
from app.providers.fal_provider import FalCatVTONProvider
from app.providers.hf_gradio_provider import HuggingFaceGradioVTONProvider
from app.providers.smart_pose_warp_provider import SmartPoseWarpVTONProvider


class MockVTONProvider:
    """
    Backward-compatible adapter delegating to SmartPoseWarpVTONProvider.
    NEVER uses legacy polygon placeholders or face-overwriting static overlays.
    """

    name: str = "mock"
    provider_type: VTONProviderType = "SMART_POSE_WARP"
    capabilities: ProviderCapabilities = ProviderCapabilities(
        name="mock",
        display_name="Atelier Smart Pose-Warp Local CV Engine ($0)",
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
        self._delegate = SmartPoseWarpVTONProvider(
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )

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
        res = await self._delegate.render_step(
            person_image_bytes=person_image_bytes,
            garment_image_bytes=garment_image_bytes,
            garment_image_url=garment_image_url,
            garment_category=garment_category,
            garment_label=garment_label,
            step_order=step_order,
            total_steps=total_steps,
            pose_landmarks=pose_landmarks,
        )
        return VTONRenderStepResult(
            image_bytes=res.image_bytes,
            content_type=res.content_type,
            provider_type=res.provider_type,
            provider_display_badge=res.provider_display_badge or POSE_WARP_BADGE,
            external_job_id=res.external_job_id,
            estimated_cost_usd=0.0,
            latency_ms=res.latency_ms,
            notes=res.notes,
        )

    async def generate(self, request: VTONRequest) -> VTONResult:
        return await self._delegate.generate(request)

    async def health_check(self) -> bool:
        return True


def list_registered_providers(active_provider: str = "auto") -> list[dict[str, Any]]:
    """Return catalog of all 3-tier VTON provider adapters."""
    normalized = (active_provider or "auto").strip().lower()
    return [
        {
            "name": AutoVTONProvider.name,
            "providerType": "SMART_POSE_WARP",
            "displayName": AutoVTONProvider.capabilities.display_name,
            "mode": AutoVTONProvider.capabilities.mode,
            "active": normalized == "auto",
            "status": "active",
            "supportedCategories": list(AutoVTONProvider.capabilities.supported_categories),
            "supportedAspectRatios": list(AutoVTONProvider.capabilities.supported_aspect_ratios),
            "supportsAlphaCutout": True,
        },
        {
            "name": FalCatVTONProvider.name,
            "providerType": "FAL_CATVTON",
            "displayName": FalCatVTONProvider.capabilities.display_name,
            "mode": FalCatVTONProvider.capabilities.mode,
            "active": normalized in ("fal", "fal_catvton", "catvton"),
            "status": "active",
            "supportedCategories": list(FalCatVTONProvider.capabilities.supported_categories),
            "supportedAspectRatios": list(FalCatVTONProvider.capabilities.supported_aspect_ratios),
            "supportsAlphaCutout": True,
        },
        {
            "name": HuggingFaceGradioVTONProvider.name,
            "providerType": "HF_GRADIO_VTON",
            "displayName": HuggingFaceGradioVTONProvider.capabilities.display_name,
            "mode": HuggingFaceGradioVTONProvider.capabilities.mode,
            "active": normalized in ("hf", "hf_gradio", "hf_gradio_vton"),
            "status": "active",
            "supportedCategories": list(
                HuggingFaceGradioVTONProvider.capabilities.supported_categories
            ),
            "supportedAspectRatios": list(
                HuggingFaceGradioVTONProvider.capabilities.supported_aspect_ratios
            ),
            "supportsAlphaCutout": True,
        },
        {
            "name": SmartPoseWarpVTONProvider.name,
            "providerType": "SMART_POSE_WARP",
            "displayName": SmartPoseWarpVTONProvider.capabilities.display_name,
            "mode": SmartPoseWarpVTONProvider.capabilities.mode,
            "active": normalized in ("pose_warp", "smart_pose_warp", "mock"),
            "status": "active",
            "supportedCategories": list(
                SmartPoseWarpVTONProvider.capabilities.supported_categories
            ),
            "supportedAspectRatios": list(
                SmartPoseWarpVTONProvider.capabilities.supported_aspect_ratios
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
    fal_catvton_url: str = "https://queue.fal.run/fal-ai/cat-vton",
    fal_timeout_seconds: float = 45.0,
    hf_token: str = "",
    hf_vton_timeout_seconds: float = 40.0,
    hf_vton_enabled: bool = True,
) -> VTONProvider:
    """
    Resolve configured VTON provider:
      - `auto` (default): 3-Tier AutoVTONProvider (POSE_TOO_CLOSE gate -> Fal -> HF Gradio -> SmartPoseWarp)
      - `fal`: FalCatVTONProvider (or AutoVTONProvider with Fal Tier 1 when key set)
      - `hf_gradio`: AutoVTONProvider starting at Tier 2 HF Gradio -> Tier 3 SmartPoseWarp
      - `pose_warp` / `smart_pose_warp` / `mock`: SmartPoseWarpVTONProvider (Zero face pasting)
    """
    normalized = (provider_name or "auto").strip().lower()

    pose_warp = SmartPoseWarpVTONProvider(
        private_bucket=private_bucket,
        purge_ttl_minutes=purge_ttl_minutes,
    )

    if normalized in ("pose_warp", "smart_pose_warp", "mock"):
        return pose_warp

    if normalized in ("fal", "fal_catvton", "catvton"):
        fal = FalCatVTONProvider(
            fal_key=fal_key,
            endpoint_url=fal_catvton_url,
            timeout_seconds=fal_timeout_seconds,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )
        return AutoVTONProvider(
            fal_provider=fal,
            hf_provider=None,
            pose_warp_provider=pose_warp,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )

    if normalized in ("hf", "hf_gradio", "hf_gradio_vton"):
        hf = HuggingFaceGradioVTONProvider(
            hf_token=hf_token,
            timeout_seconds=hf_vton_timeout_seconds,
            enabled=hf_vton_enabled,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )
        return AutoVTONProvider(
            fal_provider=None,
            hf_provider=hf,
            pose_warp_provider=pose_warp,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )

    # Default: "auto" -> 3-tier chain (Fal -> HF Gradio -> SmartPoseWarp)
    fal_tier = (
        FalCatVTONProvider(
            fal_key=fal_key,
            endpoint_url=fal_catvton_url,
            timeout_seconds=fal_timeout_seconds,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )
        if (fal_key or "").strip()
        else None
    )
    hf_tier = (
        HuggingFaceGradioVTONProvider(
            hf_token=hf_token,
            timeout_seconds=hf_vton_timeout_seconds,
            enabled=hf_vton_enabled,
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )
        if hf_vton_enabled
        else None
    )
    return AutoVTONProvider(
        fal_provider=fal_tier,
        hf_provider=hf_tier,
        pose_warp_provider=pose_warp,
        private_bucket=private_bucket,
        purge_ttl_minutes=purge_ttl_minutes,
    )
