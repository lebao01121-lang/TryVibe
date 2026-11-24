"""VTON provider protocol, 3-tier Auto orchestrator, Fal CatVTON, HF Gradio, and Smart Pose-Warp."""

from app.providers.auto_provider import AutoVTONProvider
from app.providers.base import (
    DEFAULT_POSE_TOO_CLOSE_MESSAGE,
    GENERATIVE_VTON_BADGE,
    POSE_WARP_BADGE,
    PROVIDER_DISPLAY_BADGES,
    GarmentCategory,
    PoseTooCloseError,
    ProviderCapabilities,
    VTONProvider,
    VTONProviderType,
    VTONRenderStepResult,
    VTONRequest,
    VTONResult,
    VTONStepCategory,
    get_provider_display_badge,
)
from app.providers.fal_provider import FalCatVTONProvider
from app.providers.hf_gradio_provider import HuggingFaceGradioVTONProvider
from app.providers.mock_provider import (
    MockVTONProvider,
    get_vton_provider,
    list_registered_providers,
)
from app.providers.smart_pose_warp_provider import (
    DetectedPose,
    SmartPoseWarpVTONProvider,
    detect_pose_and_validate,
)

__all__ = [
    "AutoVTONProvider",
    "DEFAULT_POSE_TOO_CLOSE_MESSAGE",
    "DetectedPose",
    "FalCatVTONProvider",
    "GENERATIVE_VTON_BADGE",
    "GarmentCategory",
    "HuggingFaceGradioVTONProvider",
    "MockVTONProvider",
    "POSE_WARP_BADGE",
    "PROVIDER_DISPLAY_BADGES",
    "PoseTooCloseError",
    "ProviderCapabilities",
    "SmartPoseWarpVTONProvider",
    "VTONProvider",
    "VTONProviderType",
    "VTONRenderStepResult",
    "VTONRequest",
    "VTONResult",
    "VTONStepCategory",
    "detect_pose_and_validate",
    "get_provider_display_badge",
    "get_vton_provider",
    "list_registered_providers",
]
