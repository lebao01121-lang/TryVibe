from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Protocol, runtime_checkable

GarmentCategory = Literal["TOP", "BOTTOM", "ONE_PIECE", "OUTERWEAR"]
VTONStepCategory = Literal["UPPER", "LOWER", "OVERALL"]
VTONProviderType = Literal[
    "FAL_CATVTON",
    "HF_GRADIO_VTON",
    "SMART_POSE_WARP",
    "CACHE_HIT",
    "MOCK",
]

GENERATIVE_VTON_BADGE = "AI VTON Tạo Sinh"
POSE_WARP_BADGE = "Căn Dáng Khớp Vai Nội Bộ"

PROVIDER_DISPLAY_BADGES: dict[str, str] = {
    "FAL_CATVTON": GENERATIVE_VTON_BADGE,
    "HF_GRADIO_VTON": GENERATIVE_VTON_BADGE,
    "SMART_POSE_WARP": POSE_WARP_BADGE,
    "MOCK": POSE_WARP_BADGE,
    "CACHE_HIT": POSE_WARP_BADGE,
}

DEFAULT_POSE_TOO_CLOSE_MESSAGE = (
    "Ảnh chụp đang quá gần khuôn mặt (chưa thấy rõ hai vai và phần thân áo). "
    "Bạn hãy lùi xa camera khoảng 1–1.2m để thấy từ đầu đến ngang eo, "
    "hoặc chọn ảnh mẫu / tải ảnh bán thân lên nhé!"
)


def get_provider_display_badge(provider_type: str | None) -> str:
    if not provider_type:
        return POSE_WARP_BADGE
    return PROVIDER_DISPLAY_BADGES.get(provider_type.strip().upper(), POSE_WARP_BADGE)


class PoseTooCloseError(Exception):
    """Raised when uploaded portrait is a close-up face photo lacking visible shoulders/torso."""

    def __init__(
        self,
        message: str = DEFAULT_POSE_TOO_CLOSE_MESSAGE,
        *,
        code: str = "POSE_TOO_CLOSE",
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


@dataclass(frozen=True)
class ProviderCapabilities:
    name: str
    display_name: str
    mode: Literal["mock", "remote-api", "local-gpu", "hybrid-auto", "local-cv"]
    supported_categories: tuple[GarmentCategory, ...]
    supported_aspect_ratios: tuple[str, ...]
    supports_alpha_cutout: bool
    status: Literal["active", "planned"] = "active"


@dataclass(frozen=True)
class VTONRequest:
    user_id: str
    garment_sku_id: str
    garment_image_url: str
    person_image_fingerprint: str
    garment_category: GarmentCategory = "TOP"
    aspect_ratio: Literal["2:3", "3:4"] = "2:3"
    correlation_id: str = ""
    metadata: dict[str, str] = field(default_factory=dict)
    pose_landmarks: dict[str, Any] | None = None


@dataclass(frozen=True)
class VTONResult:
    job_id: str
    provider: str
    status: Literal["COMPLETED", "FAILED"]
    result_bucket: str
    result_object_key: str
    preview_url: str
    aspect_ratio: str
    latency_ms: int
    created_at: datetime
    expires_at: datetime
    notes: str = ""


@dataclass(frozen=True)
class VTONRenderStepResult:
    image_bytes: bytes
    content_type: str
    provider_type: VTONProviderType
    external_job_id: str
    estimated_cost_usd: float
    latency_ms: int
    provider_display_badge: str = POSE_WARP_BADGE
    notes: str = ""


@runtime_checkable
class VTONProvider(Protocol):
    """Pluggable Virtual Try-On provider interface."""

    name: str
    provider_type: VTONProviderType
    capabilities: ProviderCapabilities

    async def generate(self, request: VTONRequest) -> VTONResult:
        """Render a deterministic preview summary."""
        ...

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
        """Render one VTON compositing step (UPPER, LOWER, or OVERALL) returning image bytes."""
        ...

    async def health_check(self) -> bool:
        """Return True if the provider adapter is ready to accept jobs."""
        ...
