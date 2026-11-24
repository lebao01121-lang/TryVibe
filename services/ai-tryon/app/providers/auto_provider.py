from __future__ import annotations

import logging
from typing import Any

from app.providers.base import (
    PoseTooCloseError,
    ProviderCapabilities,
    VTONProviderType,
    VTONRenderStepResult,
    VTONRequest,
    VTONResult,
    VTONStepCategory,
)
from app.providers.fal_provider import FalCatVTONProvider
from app.providers.hf_gradio_provider import HuggingFaceGradioVTONProvider
from app.providers.smart_pose_warp_provider import SmartPoseWarpVTONProvider

logger = logging.getLogger("atelier.ai_tryon.auto_provider")


class AutoVTONProvider:
    """
    3-Tier VTON Orchestrator (`TRYON_PROVIDER=auto`):
      0. Mandatory POSE_TOO_CLOSE gate BEFORE any remote API call (fast fail + quota refund)
      1. Tier 1: FalCatVTONProvider (when FAL_KEY configured)
      2. Tier 2: HuggingFaceGradioVTONProvider (IDM-VTON -> CatVTON -> Kolors, bounded timeout)
      3. Tier 3: SmartPoseWarpVTONProvider (OpenCV warpPerspective + strict face/chin protection)
    """

    name: str = "auto"
    provider_type: VTONProviderType = "SMART_POSE_WARP"
    capabilities: ProviderCapabilities = ProviderCapabilities(
        name="auto",
        display_name="Atelier 3-Tier Auto VTON (Fal CatVTON -> HF Gradio -> Smart Pose-Warp)",
        mode="hybrid-auto",
        supported_categories=("TOP", "BOTTOM", "ONE_PIECE", "OUTERWEAR"),
        supported_aspect_ratios=("3:4", "2:3"),
        supports_alpha_cutout=True,
        status="active",
    )

    def __init__(
        self,
        *,
        fal_provider: FalCatVTONProvider | None = None,
        hf_provider: HuggingFaceGradioVTONProvider | None = None,
        pose_warp_provider: SmartPoseWarpVTONProvider | None = None,
        private_bucket: str = "atelier-private-tryon",
        purge_ttl_minutes: int = 15,
    ) -> None:
        self.fal_provider = fal_provider
        self.hf_provider = hf_provider
        self.pose_warp_provider = pose_warp_provider or SmartPoseWarpVTONProvider(
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )
        self.private_bucket = private_bucket
        self.purge_ttl_minutes = purge_ttl_minutes

        if self.fal_provider and self.fal_provider.fal_key:
            self.provider_type = "FAL_CATVTON"
        elif self.hf_provider and self.hf_provider.enabled:
            self.provider_type = "HF_GRADIO_VTON"
        else:
            self.provider_type = "SMART_POSE_WARP"

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
        # STEP 0 — Hard POSE_TOO_CLOSE validation BEFORE Tier 1 & Tier 2 external calls!
        # Reuses computed silhouette/face pose cleanly if falling back to Tier 3.
        precomputed_pose = await self.pose_warp_provider.validate_pose(
            person_image_bytes,
            pose_landmarks=pose_landmarks,
        )

        # TIER 1 — fal.ai CatVTON (when FAL_KEY is non-empty)
        if self.fal_provider is not None and self.fal_provider.fal_key:
            try:
                return await self.fal_provider.render_step(
                    person_image_bytes=person_image_bytes,
                    garment_image_bytes=garment_image_bytes,
                    garment_image_url=garment_image_url,
                    garment_category=garment_category,
                    garment_label=garment_label,
                    step_order=step_order,
                    total_steps=total_steps,
                    pose_landmarks=pose_landmarks,
                )
            except PoseTooCloseError:
                raise
            except Exception as exc:
                logger.warning(
                    "Tier 1 FalCatVTONProvider failed (%s: %s); falling back to Tier 2 HF Gradio.",
                    exc.__class__.__name__,
                    str(exc)[:200],
                )

        # TIER 2 — HuggingFace Gradio VTON Spaces (IDM-VTON / CatVTON / Kolors)
        if self.hf_provider is not None and self.hf_provider.enabled:
            try:
                return await self.hf_provider.render_step(
                    person_image_bytes=person_image_bytes,
                    garment_image_bytes=garment_image_bytes,
                    garment_image_url=garment_image_url,
                    garment_category=garment_category,
                    garment_label=garment_label,
                    step_order=step_order,
                    total_steps=total_steps,
                    pose_landmarks=pose_landmarks,
                )
            except PoseTooCloseError:
                raise
            except Exception as exc:
                logger.warning(
                    "Tier 2 HuggingFaceGradioVTONProvider failed (%s: %s); falling back to Tier 3 SmartPoseWarp.",
                    exc.__class__.__name__,
                    str(exc)[:200],
                )

        # TIER 3 — SmartPoseWarpVTONProvider (Zero face pasting, real RGBA OpenCV perspective warp)
        return await self.pose_warp_provider.render_step(
            person_image_bytes=person_image_bytes,
            garment_image_bytes=garment_image_bytes,
            garment_image_url=garment_image_url,
            garment_category=garment_category,
            garment_label=garment_label,
            step_order=step_order,
            total_steps=total_steps,
            pose_landmarks=pose_landmarks,
            precomputed_pose=precomputed_pose,
        )

    async def generate(self, request: VTONRequest) -> VTONResult:
        return await self.pose_warp_provider.generate(request)

    async def health_check(self) -> bool:
        return await self.pose_warp_provider.health_check()
