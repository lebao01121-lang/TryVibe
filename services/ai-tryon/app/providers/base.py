from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Protocol, overload, runtime_checkable

GarmentCategory = Literal["TOP", "BOTTOM", "ONE_PIECE", "OUTERWEAR"]
VTONStepCategory = Literal["UPPER", "LOWER", "OVERALL"]
ClothType = Literal["upper", "lower", "overall", "outerwear"]
LightingPreset = Literal["morning", "atelier", "evening"]

VTONProviderType = Literal[
    "FAL_CATVTON",
    "FASHN_VTON",
    "LOCAL_GPU_VTON",
    "HF_GRADIO_VTON",
    "PHOTOMETRIC_INPAINT",
    "SMART_POSE_WARP",
    "CACHE_HIT",
    "MOCK",
]

GENERATIVE_VTON_BADGE = "✦ AI VTON Tạo Sinh"
PHOTOMETRIC_INPAINT_BADGE = "✦ AI Atelier Phom Chuẩn"
POSE_WARP_BADGE = PHOTOMETRIC_INPAINT_BADGE
CACHE_HIT_BADGE = "⚡ Tức thì từ bộ nhớ đệm"

PROVIDER_DISPLAY_BADGES: dict[str, str] = {
    "FAL_CATVTON": GENERATIVE_VTON_BADGE,
    "FAL": GENERATIVE_VTON_BADGE,
    "FASHN_VTON": GENERATIVE_VTON_BADGE,
    "FASHN": GENERATIVE_VTON_BADGE,
    "LOCAL_GPU_VTON": GENERATIVE_VTON_BADGE,
    "LOCAL_GPU": GENERATIVE_VTON_BADGE,
    "HF_GRADIO_VTON": GENERATIVE_VTON_BADGE,
    "HF_GRADIO": GENERATIVE_VTON_BADGE,
    "CATVTON": GENERATIVE_VTON_BADGE,
    "PHOTOMETRIC_INPAINT": PHOTOMETRIC_INPAINT_BADGE,
    "SMART_POSE_WARP": PHOTOMETRIC_INPAINT_BADGE,
    "POSE_WARP": PHOTOMETRIC_INPAINT_BADGE,
    "MOCK": PHOTOMETRIC_INPAINT_BADGE,
    "CACHE_HIT": CACHE_HIT_BADGE,
}

DEFAULT_POSE_TOO_CLOSE_MESSAGE = (
    "Ảnh chụp đang quá gần khuôn mặt (chưa thấy rõ hai vai và phần thân áo). "
    "Bạn hãy lùi xa camera khoảng 1–1.2m để thấy từ đầu đến ngang eo, "
    "hoặc chọn ảnh mẫu / tải ảnh bán thân lên nhé!"
)


def get_provider_display_badge(provider_type: str | None) -> str:
    if not provider_type:
        return PHOTOMETRIC_INPAINT_BADGE
    return PROVIDER_DISPLAY_BADGES.get(
        provider_type.strip().upper(),
        PHOTOMETRIC_INPAINT_BADGE,
    )


def normalize_cloth_type(raw: str | None) -> ClothType:
    """Normalize slot/category strings (`UPPER`, `onePiece`, `TOP`, `outerwear`, etc.) into canonical `ClothType`."""
    val = (raw or "upper").strip().lower().replace("-", "_").replace(" ", "_")
    if val in ("lower", "bottom", "bottoms", "pants", "trousers", "skirt"):
        return "lower"
    if val in ("overall", "one_piece", "onepiece", "dress", "dresses", "full", "full_body"):
        return "overall"
    if val in ("outerwear", "jacket", "coat", "blazer", "cardigan", "trench"):
        return "outerwear"
    return "upper"


def cloth_type_to_step_category(cloth_type: str | None) -> VTONStepCategory:
    ct = normalize_cloth_type(cloth_type)
    if ct == "lower":
        return "LOWER"
    if ct == "overall":
        return "OVERALL"
    return "UPPER"


def normalize_lighting_preset(raw: str | None) -> LightingPreset:
    val = (raw or "atelier").strip().lower()
    if val == "morning":
        return "morning"
    if val == "evening":
        return "evening"
    return "atelier"


_VI_COLOR_TO_EN: tuple[tuple[str, str], ...] = (
    ("kem cashmere", "ivory cream"),
    ("kem ngà", "warm ivory"),
    ("ngà", "ivory"),
    ("trắng", "off-white"),
    ("cacao", "deep espresso brown"),
    ("nâu", "rich brown"),
    ("espresso", "espresso brown"),
    ("đen", "jet black"),
    ("than", "charcoal grey"),
    ("xám", "heather grey"),
    ("rêu", "sage olive green"),
    ("xanh", "muted navy blue"),
    ("đỏ rượu", "deep burgundy wine"),
    ("rượu vang", "burgundy wine"),
    ("đỏ", "crimson"),
    ("cát", "warm sand beige"),
    ("be", "warm beige"),
    ("champagne", "champagne beige"),
    ("vàng", "muted gold"),
    ("hồng", "dusty rose"),
)

_VI_FABRIC_TO_EN: tuple[tuple[str, str], ...] = (
    ("cashmere", "cashmere"),
    ("lụa tơ tằm", "mulberry silk"),
    ("lụa satin", "silk satin"),
    ("lụa organza", "silk organza"),
    ("lụa", "silk"),
    ("tweed", "handwoven tweed"),
    ("linen", "organic linen"),
    ("wool blend", "tailored wool blend"),
    ("len merino", "merino wool knit"),
    ("len", "fine knit"),
    ("gabardine", "cotton gabardine"),
    ("dệt kim", "fine knit"),
    ("cotton", "cotton"),
)

_VI_SILHOUETTE_TO_EN: tuple[tuple[str, str], ...] = (
    ("cổ lọ", "turtleneck sweater"),
    ("sơ mi", "tailored blouse"),
    ("blazer", "tailored blazer"),
    ("trench", "classic trench coat"),
    ("cardigan", "button cardigan"),
    ("áo khoác", "tailored jacket"),
    ("áo kiểu", "draped blouse"),
    ("polo", "knit polo top"),
    ("chân váy", "pleated midi skirt"),
    ("culottes", "wide-leg culottes"),
    ("quần ống suông", "wide-leg tailored trousers"),
    ("quần tây", "pleated tailored trousers"),
    ("quần", "tailored trousers"),
    ("đầm dự tiệc", "evening satin midi dress"),
    ("đầm midi", "tailored midi dress"),
    ("đầm", "tailored dress"),
    ("áo dài", "vietnamese silk ao dai"),
)


def build_english_garment_prompt(
    garment_name: str = "",
    cloth_type: str = "upper",
    color_name: str | None = None,
    color_hex: str | None = None,
) -> str:
    """
    Generate a clean English diffusion garment description from Vietnamese/English catalog titles
    and swatch names, e.g. `"ivory cashmere turtleneck sweater"` or `"ivory mulberry silk blouse"`.
    """
    combined = f"{color_name or ''} {garment_name or ''}".strip().lower()
    ct = normalize_cloth_type(cloth_type)

    color_en = ""
    for vi_key, en_val in _VI_COLOR_TO_EN:
        if vi_key in combined:
            color_en = en_val
            break
    if not color_en and color_hex:
        hex_clean = color_hex.strip().lstrip("#")
        if len(hex_clean) == 6:
            try:
                r, g, b = int(hex_clean[0:2], 16), int(hex_clean[2:4], 16), int(hex_clean[4:6], 16)
                luma = 0.299 * r + 0.587 * g + 0.114 * b
                if luma > 215:
                    color_en = "ivory"
                elif luma < 52:
                    color_en = "espresso black" if r > b + 6 else "jet black"
                elif luma < 95 and r > b + 12:
                    color_en = "deep cocoa brown"
                elif r > g + 30 and r > b + 30:
                    color_en = "burgundy wine"
                elif g >= r and g >= b:
                    color_en = "sage green"
                else:
                    color_en = "warm beige"
            except ValueError:
                pass

    fabric_en = ""
    for vi_key, en_val in _VI_FABRIC_TO_EN:
        if vi_key in combined:
            fabric_en = en_val
            break

    silhouette_en = ""
    for vi_key, en_val in _VI_SILHOUETTE_TO_EN:
        if vi_key in combined:
            silhouette_en = en_val
            break

    if not silhouette_en:
        if ct == "lower":
            silhouette_en = "tailored wide-leg trousers"
        elif ct == "overall":
            silhouette_en = "tailored midi dress"
        elif ct == "outerwear":
            silhouette_en = "tailored luxury jacket"
        else:
            silhouette_en = "tailored luxury top"

    parts = [p for p in (color_en, fabric_en, silhouette_en) if p]
    # Deduplicate repeated tokens (e.g., "silk" in both fabric & silhouette)
    deduped: list[str] = []
    seen_words: set[str] = set()
    for part in parts:
        words = [w for w in part.split() if w not in seen_words]
        if words:
            deduped.append(" ".join(words))
            seen_words.update(words)

    prompt = " ".join(deduped).strip()
    return prompt or "tailored luxury quiet-luxury garment"


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
    pose_landmarks: dict[str, Any] | list[dict[str, Any]] | None = None


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
    provider_display_badge: str = PHOTOMETRIC_INPAINT_BADGE
    clean_collar_applied: bool = False
    provider_used: str = ""
    notes: str = ""


@dataclass(frozen=True)
class TryOnGenerationRequest:
    """
    Canonical Stage 2 VTON generation request accepted by all 4 provider tiers
    and `CompositeVtonRouter`.
    """

    person_bytes: bytes | None = None
    human_image_url: str | None = None
    garment_bytes: bytes | None = None
    garment_image_url: str | None = None
    cloth_type: str = "upper"  # "upper" | "lower" | "overall" | "outerwear"
    garment_name: str = ""
    color_hex: str | None = None
    color_name: str | None = None
    lighting_preset: str = "atelier"  # "morning" | "atelier" | "evening"
    pose_landmarks: list[dict[str, Any]] | dict[str, Any] | None = None
    step_order: int = 1
    total_steps: int = 1
    correlation_id: str = ""
    timeout_seconds: float | None = None

    @property
    def normalized_cloth_type(self) -> ClothType:
        return normalize_cloth_type(self.cloth_type)

    @property
    def step_category(self) -> VTONStepCategory:
        return cloth_type_to_step_category(self.cloth_type)

    @property
    def normalized_lighting_preset(self) -> LightingPreset:
        return normalize_lighting_preset(self.lighting_preset)

    @property
    def english_prompt(self) -> str:
        return build_english_garment_prompt(
            garment_name=self.garment_name,
            cloth_type=self.cloth_type,
            color_name=self.color_name,
            color_hex=self.color_hex,
        )


@dataclass(frozen=True)
class TryOnGenerationResult:
    """
    Canonical Stage 2 VTON generation result (`768x1024`) returned by all 4 provider tiers
    and `CompositeVtonRouter`.
    """

    result_bytes: bytes
    provider_used: str
    provider_badge: str
    latency_ms: int
    clean_collar_applied: bool = False
    content_type: str = "image/webp"
    provider_type: VTONProviderType = "PHOTOMETRIC_INPAINT"
    external_job_id: str = ""
    estimated_cost_usd: float = 0.0
    width: int = 768
    height: int = 1024
    notes: str = ""

    def to_step_result(self) -> VTONRenderStepResult:
        return VTONRenderStepResult(
            image_bytes=self.result_bytes,
            content_type=self.content_type,
            provider_type=self.provider_type,
            external_job_id=self.external_job_id or f"{self.provider_used}_step",
            estimated_cost_usd=self.estimated_cost_usd,
            latency_ms=self.latency_ms,
            provider_display_badge=self.provider_badge,
            clean_collar_applied=self.clean_collar_applied,
            provider_used=self.provider_used,
            notes=self.notes,
        )


@runtime_checkable
class VTONProvider(Protocol):
    """Pluggable Virtual Try-On provider interface (Stage 1 + Stage 2 compatible)."""

    name: str
    provider_type: VTONProviderType
    capabilities: ProviderCapabilities

    async def synthesize(self, request: TryOnGenerationRequest) -> TryOnGenerationResult:
        """Render a single 768x1024 VTON step from a canonical Stage 2 request."""
        ...

    @overload
    async def generate(self, request: TryOnGenerationRequest) -> TryOnGenerationResult: ...

    @overload
    async def generate(self, request: VTONRequest) -> VTONResult: ...

    async def generate(
        self,
        request: TryOnGenerationRequest | VTONRequest,
    ) -> TryOnGenerationResult | VTONResult:
        """Polymorphic generate: returns TryOnGenerationResult for Stage 2 requests, VTONResult for legacy preview."""
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
        pose_landmarks: dict[str, Any] | list[dict[str, Any]] | None = None,
        color_hex: str | None = None,
        color_name: str | None = None,
        lighting_preset: str = "atelier",
    ) -> VTONRenderStepResult:
        """Backward-compatible single-step render API used by TryOnWorkerConsumer."""
        ...

    async def health_check(self) -> bool:
        """Return True if the provider adapter is ready to accept jobs."""
        ...


class BaseVtonProvider(ABC):
    """
    Base class unifying Stage 2 `synthesize(TryOnGenerationRequest)` with backwards-compatible
    `generate(TryOnGenerationRequest | VTONRequest)` and `render_step(...)`.
    """

    name: str = "base"
    provider_type: VTONProviderType = "PHOTOMETRIC_INPAINT"
    capabilities: ProviderCapabilities = ProviderCapabilities(
        name="base",
        display_name="Base VTON Provider",
        mode="local-cv",
        supported_categories=("TOP", "BOTTOM", "ONE_PIECE", "OUTERWEAR"),
        supported_aspect_ratios=("3:4", "2:3"),
        supports_alpha_cutout=True,
        status="active",
    )

    @abstractmethod
    async def synthesize(self, request: TryOnGenerationRequest) -> TryOnGenerationResult:
        """Execute Stage 2 VTON synthesis and return a 768x1024 TryOnGenerationResult."""
        raise NotImplementedError

    @abstractmethod
    async def _generate_legacy_preview(self, request: VTONRequest) -> VTONResult:
        """Execute legacy Phase 0 deterministic preview metadata generation."""
        raise NotImplementedError

    @overload
    async def generate(self, request: TryOnGenerationRequest) -> TryOnGenerationResult: ...

    @overload
    async def generate(self, request: VTONRequest) -> VTONResult: ...

    async def generate(
        self,
        request: TryOnGenerationRequest | VTONRequest,
    ) -> TryOnGenerationResult | VTONResult:
        if isinstance(request, TryOnGenerationRequest):
            return await self.synthesize(request)
        return await self._generate_legacy_preview(request)

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
        pose_landmarks: dict[str, Any] | list[dict[str, Any]] | None = None,
        color_hex: str | None = None,
        color_name: str | None = None,
        lighting_preset: str = "atelier",
    ) -> VTONRenderStepResult:
        cloth_type = normalize_cloth_type(garment_category)
        req = TryOnGenerationRequest(
            person_bytes=person_image_bytes,
            garment_bytes=garment_image_bytes,
            garment_image_url=garment_image_url,
            cloth_type=cloth_type,
            garment_name=garment_label,
            color_hex=color_hex,
            color_name=color_name,
            lighting_preset=lighting_preset,
            pose_landmarks=pose_landmarks,
            step_order=step_order,
            total_steps=total_steps,
        )
        res = await self.synthesize(req)
        return res.to_step_result()

    async def health_check(self) -> bool:
        return True
