from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

from app.config import REPO_ROOT
from app.db.models import utcnow
from app.providers.base import (
    TryOnGenerationRequest,
    VTONProvider,
    get_provider_display_badge,
)
from app.providers.mock_provider import get_vton_provider
from app.storage.minio_client import MinioStorageClient

logger = logging.getLogger("atelier.ai_tryon.lookbook_studio")

LOOKBOOK_WIDTH = 768
LOOKBOOK_HEIGHT = 1024

STOREFRONT_PUBLIC_DIR = REPO_ROOT / "apps" / "storefront" / "public"
TRYON_MODELS_DIR = STOREFRONT_PUBLIC_DIR / "images" / "tryon-models"
SEASONS_VITRINE_LOOKBOOKS_DIR = (
    STOREFRONT_PUBLIC_DIR / "images" / "seasons-vitrine" / "lookbooks"
)


@dataclass(frozen=True)
class VirtualStudioModel:
    code: str
    display_name: str
    height_cm: int
    weight_kg: int | None
    gender: Literal["FEMALE", "MALE", "UNISEX"]
    vibe: str
    studio_backdrop: str
    palette: tuple[str, str, str]
    portrait_rel_path: str
    is_dark_scene: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "displayName": self.display_name,
            "heightCm": self.height_cm,
            "weightKg": self.weight_kg,
            "gender": self.gender,
            "vibe": self.vibe,
            "studioBackdrop": self.studio_backdrop,
            "palette": list(self.palette),
            "portraitAsset": f"/{self.portrait_rel_path.lstrip('/')}",
        }


VIRTUAL_STUDIO_MODELS: tuple[VirtualStudioModel, ...] = (
    VirtualStudioModel(
        code="MODEL_VN_FEMALE_01",
        display_name="Linh Chi · Studio Nắng Sớm (1m68 · 49kg)",
        height_cm=168,
        weight_kg=49,
        gender="FEMALE",
        vibe="Ánh nắng sớm Hà Nội · Tông kem ngà nhẹ bẫng",
        studio_backdrop="Warm Morning Ivory Studio",
        palette=("#FBF7EF", "#F0E4CE", "#B08A4A"),
        portrait_rel_path="images/tryon-models/vn-model-petite-xs.webp",
        is_dark_scene=False,
    ),
    VirtualStudioModel(
        code="MODEL_VN_FEMALE_02",
        display_name="Ngọc Diệp · Atelier Tràng Tiền (1m72 · 52kg)",
        height_cm=172,
        weight_kg=52,
        gender="FEMALE",
        vibe="Kiến trúc Đông Dương · Phom dáng thanh lịch Tràng Tiền",
        studio_backdrop="Trang Tien Archway Daylight",
        palette=("#F4EBDA", "#DFCEB4", "#6E5035"),
        portrait_rel_path="images/tryon-models/vn-model-balanced-s.webp",
        is_dark_scene=False,
    ),
    VirtualStudioModel(
        code="MODEL_VN_MALE_01",
        display_name="Minh Quân · Heritage Linen (1m79 · 68kg)",
        height_cm=179,
        weight_kg=68,
        gender="MALE",
        vibe="Tối giản đương đại · Sắc cát đá & linen tự nhiên",
        studio_backdrop="Warm Sandstone Atelier",
        palette=("#EFE7DA", "#CFC2AE", "#3B2D24"),
        portrait_rel_path="images/tryon-models/vn-model-tall-m.webp",
        is_dark_scene=False,
    ),
    VirtualStudioModel(
        code="MODEL_VN_MALE_02",
        display_name="Hoàng Nam · Evening Tailoring (1m82 · 72kg)",
        height_cm=182,
        weight_kg=72,
        gender="MALE",
        vibe="Dạ tiệc sang trọng · Ánh đèn champagne trên nền cacao trầm",
        studio_backdrop="Evening Cocoa & Champagne Spotlight",
        palette=("#261B15", "#1C1410", "#EBCF8F"),
        portrait_rel_path="images/tryon-models/vn-model-curvy-l.webp",
        is_dark_scene=True,
    ),
    VirtualStudioModel(
        code="MODEL_EDITORIAL_UNISEX_01",
        display_name="TryVibe Editorial · Warm Ivory Studio (1m75)",
        height_cm=175,
        weight_kg=None,
        gender="UNISEX",
        vibe="Nghệ thuật triển lãm · Phông nền ngà tinh giản Quiet Luxury",
        studio_backdrop="Gallery Warm Ivory Backdrop",
        palette=("#FAF5EC", "#ECE1CE", "#B08A4A"),
        portrait_rel_path="images/seasons-vitrine/lookbooks/xuan-tam-xuan-base.webp",
        is_dark_scene=False,
    ),
)

VIRTUAL_STUDIO_MODELS_BY_CODE: dict[str, VirtualStudioModel] = {
    m.code: m for m in VIRTUAL_STUDIO_MODELS
}


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    cleaned = hex_color.strip().lstrip("#")
    if len(cleaned) != 6:
        return (244, 235, 218)
    return (
        int(cleaned[0:2], 16),
        int(cleaned[2:4], 16),
        int(cleaned[4:6], 16),
    )


def _lerp_rgb(
    c1: tuple[int, int, int],
    c2: tuple[int, int, int],
    t: float,
) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    return (
        int(c1[0] + (c2[0] - c1[0]) * t),
        int(c1[1] + (c2[1] - c1[1]) * t),
        int(c1[2] + (c2[2] - c1[2]) * t),
    )


def _infer_scene_darkness(model: VirtualStudioModel, scene_prompt: str) -> bool:
    prompt_lower = (scene_prompt or "").lower()
    dark_tokens = ("evening", "night", "tiệc tối", "dạ tiệc", "cocoa", "candle", "velvet", "tối")
    light_tokens = ("morning", "nắng sớm", "daylight", "ivory", "linen", "sunlight", "sáng")
    if any(tok in prompt_lower for tok in dark_tokens):
        return True
    if any(tok in prompt_lower for tok in light_tokens):
        return False
    return model.is_dark_scene


def _infer_lighting_preset(model: VirtualStudioModel, scene_prompt: str) -> Literal["morning", "atelier", "evening"]:
    prompt_lower = (scene_prompt or "").lower()
    if any(tok in prompt_lower for tok in ("evening", "night", "tiệc tối", "dạ tiệc", "cocoa", "candle", "spotlight", "tối")):
        return "evening"
    if any(tok in prompt_lower for tok in ("morning", "nắng sớm", "sunrise", "ban mai", "sunlight")):
        return "morning"
    return "evening" if model.is_dark_scene else "atelier"


def _infer_cloth_type(product_name: str | None, scene_prompt: str) -> str:
    combined = f"{product_name or ''} {scene_prompt or ''}".lower()
    if any(tok in combined for tok in ("đầm", "váy liền", "dress", "áo dài", "ao dai", "jumpsuit", "overall", "one piece", "one-piece")):
        return "overall"
    if any(tok in combined for tok in ("quần", "chân váy", "trouser", "pants", "skirt", "culottes", "bottom", "lower")):
        return "lower"
    if any(tok in combined for tok in ("blazer", "trench", "coat", "jacket", "áo khoác", "cardigan", "outerwear", "măng tô")):
        return "outerwear"
    return "upper"


def _normalize_lookbook_provider_used(raw_provider_used: str | None, raw_provider_type: str | None) -> str:
    """
    Normalize actual VTON provider name into a clean <= 32-char identifier (fitting
    `lookbook_studio_sessions.provider_used VARCHAR(32)`). NEVER returns 'MOCK' for real VTON.
    """
    candidates = [raw_provider_used or "", raw_provider_type or ""]
    for raw in candidates:
        token = raw.strip().upper().replace("-", "_")
        if not token or token == "MOCK":
            continue
        if token in ("FAL", "FAL_CATVTON", "CATVTON"):
            return "FAL_CATVTON"
        if token in ("FASHN", "FASHN_VTON"):
            return "FASHN_VTON"
        if token in ("LOCAL_GPU", "LOCAL_GPU_VTON"):
            return "LOCAL_GPU_VTON"
        if token in ("HF", "HF_GRADIO", "HF_GRADIO_VTON"):
            return "HF_GRADIO_VTON"
        if token in ("PHOTOMETRIC_INPAINT", "SMART_POSE_WARP", "SMART_POSE_WARP_V2", "POSE_WARP"):
            return "SMART_POSE_WARP_V2"
        return token[:32]
    return "SMART_POSE_WARP_V2"


def _normalize_webp_768x1024(image_bytes: bytes) -> tuple[bytes, int, int]:
    """Ensure final synthesized lookbook image is a crisp 768x1024 RGB WebP."""
    with Image.open(io.BytesIO(image_bytes)) as img:
        transposed = ImageOps.exif_transpose(img)
        rgb = transposed.convert("RGB")
        if rgb.size != (LOOKBOOK_WIDTH, LOOKBOOK_HEIGHT):
            rgb = ImageOps.fit(
                rgb,
                (LOOKBOOK_WIDTH, LOOKBOOK_HEIGHT),
                method=Image.Resampling.LANCZOS,
                centering=(0.5, 0.35),
            )
        out_buf = io.BytesIO()
        rgb.save(out_buf, format="WEBP", quality=92, method=4)
        return out_buf.getvalue(), LOOKBOOK_WIDTH, LOOKBOOK_HEIGHT


def _draw_vertical_gradient(
    width: int,
    height: int,
    top_rgb: tuple[int, int, int],
    bottom_rgb: tuple[int, int, int],
) -> Image.Image:
    grad = Image.new("RGBA", (width, height))
    draw = ImageDraw.Draw(grad)
    for y in range(height):
        t = y / max(1, height - 1)
        rgb = _lerp_rgb(top_rgb, bottom_rgb, t)
        draw.line([(0, y), (width, y)], fill=(rgb[0], rgb[1], rgb[2], 255))
    return grad


def _build_fallback_garment(width: int, height: int, is_dark: bool) -> Image.Image:
    """Create a tailored studio garment cutout when no flat-lay bytes are reachable."""
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    fill = (239, 231, 218, 240) if is_dark else (58, 42, 34, 236)
    accent = (235, 207, 143, 235) if is_dark else (176, 138, 74, 235)

    poly = [
        (int(width * 0.28), int(height * 0.04)),
        (int(width * 0.43), int(height * 0.14)),
        (int(width * 0.57), int(height * 0.14)),
        (int(width * 0.72), int(height * 0.04)),
        (int(width * 0.94), int(height * 0.22)),
        (int(width * 0.87), int(height * 0.54)),
        (int(width * 0.77), int(height * 0.50)),
        (int(width * 0.80), int(height * 0.95)),
        (int(width * 0.20), int(height * 0.95)),
        (int(width * 0.23), int(height * 0.50)),
        (int(width * 0.13), int(height * 0.54)),
        (int(width * 0.06), int(height * 0.22)),
    ]
    draw.polygon(poly, fill=fill, outline=accent, width=3)
    draw.line(
        [(width // 2, int(height * 0.15)), (width // 2, int(height * 0.92))],
        fill=accent,
        width=2,
    )
    return img


def _render_editorial_lookbook_sync(
    *,
    model: VirtualStudioModel,
    scene_prompt: str,
    garment_bytes: bytes | None,
) -> bytes:
    """Last-resort 768x1024 (3:4) Pillow render used ONLY if every VTON tier fails."""
    w, h = LOOKBOOK_WIDTH, LOOKBOOK_HEIGHT
    is_dark = _infer_scene_darkness(model, scene_prompt)

    if is_dark:
        top_rgb = (44, 31, 24)
        bottom_rgb = (22, 16, 13)
        arch_rgba = (235, 207, 143, 36)
        skin_rgba = (214, 179, 152, 230)
        hair_rgba = (32, 24, 21, 245)
        floor_rgba = (16, 11, 9, 160)
    else:
        top_rgb = _hex_to_rgb(model.palette[0])
        bottom_rgb = _hex_to_rgb(model.palette[1])
        arch_rgba = (176, 138, 74, 48)
        skin_rgba = (224, 192, 168, 235)
        hair_rgba = (44, 32, 26, 240)
        floor_rgba = (196, 178, 154, 110)

    canvas = _draw_vertical_gradient(w, h, top_rgb, bottom_rgb)

    light_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ldraw = ImageDraw.Draw(light_layer)
    spot_color = (235, 207, 143, 62) if is_dark else (255, 250, 240, 120)
    ldraw.ellipse([int(w * 0.08), int(h * 0.05), int(w * 0.92), int(h * 0.72)], fill=spot_color)
    light_layer = light_layer.filter(ImageFilter.GaussianBlur(radius=54))
    canvas = Image.alpha_composite(canvas, light_layer)

    arch_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    adraw = ImageDraw.Draw(arch_layer)
    adraw.rounded_rectangle(
        [int(w * 0.11), int(h * 0.06), int(w * 0.89), int(h * 0.94)],
        radius=int(w * 0.39),
        outline=arch_rgba,
        width=3,
    )
    adraw.rectangle([0, int(h * 0.86), w, h], fill=floor_rgba)
    canvas = Image.alpha_composite(canvas, arch_layer)

    figure_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    fdraw = ImageDraw.Draw(figure_layer)
    cx = w // 2
    shoulder_half = 106 if model.gender == "MALE" else (85 if model.gender == "FEMALE" else 94)
    hip_half = 83 if model.gender == "MALE" else (90 if model.gender == "FEMALE" else 86)

    fdraw.ellipse(
        [cx - 140, int(h * 0.88), cx + 140, int(h * 0.93)],
        fill=(28, 20, 16, 75 if not is_dark else 135),
    )

    head_r = 46
    head_cy = int(h * 0.175)
    if model.gender == "FEMALE":
        fdraw.ellipse(
            [cx - head_r - 10, head_cy - head_r - 6, cx + head_r + 10, head_cy + head_r + 38],
            fill=hair_rgba,
        )
    else:
        fdraw.ellipse(
            [cx - head_r - 4, head_cy - head_r - 8, cx + head_r + 4, head_cy + int(head_r * 0.4)],
            fill=hair_rgba,
        )
    fdraw.ellipse(
        [cx - head_r, head_cy - head_r, cx + head_r, head_cy + head_r],
        fill=skin_rgba,
    )
    fdraw.rectangle(
        [cx - 19, head_cy + head_r - 6, cx + 19, int(h * 0.255)],
        fill=skin_rgba,
    )
    body_poly = [
        (cx - shoulder_half, int(h * 0.255)),
        (cx + shoulder_half, int(h * 0.255)),
        (cx + shoulder_half + 28, int(h * 0.56)),
        (cx + hip_half + 10, int(h * 0.58)),
        (cx + hip_half, int(h * 0.89)),
        (cx + 13, int(h * 0.89)),
        (cx, int(h * 0.62)),
        (cx - 13, int(h * 0.89)),
        (cx - hip_half, int(h * 0.89)),
        (cx - hip_half - 10, int(h * 0.58)),
        (cx - shoulder_half - 28, int(h * 0.56)),
    ]
    base_suit_rgba = (54, 42, 35, 225) if not is_dark else (228, 218, 202, 210)
    fdraw.polygon(body_poly, fill=base_suit_rgba)
    figure_layer = figure_layer.filter(ImageFilter.GaussianBlur(radius=0.8))
    canvas = Image.alpha_composite(canvas, figure_layer)

    box_x = int(w * 0.19)
    box_y = int(h * 0.235)
    box_w = int(w * 0.62)
    box_h = int(h * 0.61)

    overlay: Image.Image | None = None
    if garment_bytes:
        try:
            with Image.open(io.BytesIO(garment_bytes)) as raw:
                garment = ImageOps.exif_transpose(raw).convert("RGBA")
                bbox = garment.getbbox()
                if bbox:
                    garment = garment.crop(bbox)
                overlay = ImageOps.contain(
                    garment,
                    (box_w, box_h),
                    method=Image.Resampling.LANCZOS,
                )
        except Exception:
            overlay = None

    if overlay is None:
        overlay = _build_fallback_garment(box_w, box_h, is_dark)

    paste_x = box_x + (box_w - overlay.width) // 2
    paste_y = box_y + (box_h - overlay.height) // 2

    shadow_alpha = overlay.getchannel("A").point(lambda px: int(px * 0.30))
    shadow = Image.new("RGBA", overlay.size, (20, 14, 10, 255))
    shadow.putalpha(shadow_alpha)
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=8))
    shadow_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    shadow_layer.paste(shadow, (paste_x + 5, paste_y + 10), shadow)
    canvas = Image.alpha_composite(canvas, shadow_layer)

    edge_mask = Image.new("L", overlay.size, 255)
    edraw = ImageDraw.Draw(edge_mask)
    edraw.rectangle([0, 0, overlay.width - 1, overlay.height - 1], outline=110, width=4)
    edge_mask = edge_mask.filter(ImageFilter.GaussianBlur(radius=2))
    blended_alpha = ImageChops.multiply(overlay.getchannel("A"), edge_mask)
    overlay.putalpha(blended_alpha)

    garment_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    garment_layer.paste(overlay, (paste_x, paste_y), overlay)
    canvas = Image.alpha_composite(canvas, garment_layer)

    vignette = Image.new("RGBA", (w, h), (28, 20, 16, 48 if not is_dark else 86))
    vmask = Image.new("L", (w, h), 255)
    vdraw = ImageDraw.Draw(vmask)
    vdraw.ellipse(
        [int(w * 0.04), int(h * 0.03), int(w * 0.96), int(h * 0.97)],
        fill=0,
    )
    vmask = vmask.filter(ImageFilter.GaussianBlur(radius=76))
    vignette.putalpha(ImageChops.multiply(vignette.getchannel("A"), vmask))
    canvas = Image.alpha_composite(canvas, vignette)

    out_buf = io.BytesIO()
    canvas.convert("RGB").save(out_buf, format="WEBP", quality=90, method=4)
    return out_buf.getvalue()


@dataclass(frozen=True)
class LookbookGenerateResult:
    lookbook_id: str
    product_id: str
    variant_id: str | None
    virtual_model_code: str
    scene_prompt: str
    bucket: str
    object_key: str
    result_url: str
    provider_used: str
    width: int
    height: int
    created_at: str
    provider_badge: str = ""
    status: Literal["NHAP_AI"] = "NHAP_AI"
    auto_attach: Literal[False] = False
    auto_attach_as_tryon_garment: Literal[False] = False
    requires_human_approval: Literal[True] = True

    def as_dict(self) -> dict[str, Any]:
        return {
            "lookbookId": self.lookbook_id,
            "productId": self.product_id,
            "variantId": self.variant_id,
            "virtualModelCode": self.virtual_model_code,
            "scenePrompt": self.scene_prompt,
            "bucket": self.bucket,
            "objectKey": self.object_key,
            "resultUrl": self.result_url,
            "providerUsed": self.provider_used,
            "providerBadge": self.provider_badge or get_provider_display_badge(self.provider_used),
            "width": self.width,
            "height": self.height,
            "status": self.status,
            "autoAttach": self.auto_attach,
            "autoAttachAsTryOnGarment": self.auto_attach_as_tryon_garment,
            "requiresHumanApproval": self.requires_human_approval,
            "createdAt": self.created_at,
        }


class LookbookStudioService:
    """
    AI Lookbook Studio powered by multi-tier `AutoVTONProvider` (`CompositeVtonRouter`):
    maps all 5 virtual models to real studio portraits on disk -> synthesizes 768x1024
    editorial WebP on `atelier-public` while preserving strict Human-in-the-Loop locks.
    """

    def __init__(
        self,
        *,
        minio: MinioStorageClient,
        catalog_url: str = "http://127.0.0.1:4002",
        vton_provider: str = "auto",
        provider: VTONProvider | None = None,
        fal_key: str = "",
        fal_endpoint_url: str = "https://queue.fal.run/fal-ai/cat-vton",
        fal_timeout_seconds: float = 45.0,
        hf_token: str = "",
        hf_vton_enabled: bool = True,
        hf_vton_timeout_seconds: float = 10.0,
        lookbook_vton_timeout_seconds: float = 11.5,
    ) -> None:
        self.minio = minio
        self.catalog_url = catalog_url.rstrip("/")
        self.vton_provider = (vton_provider or "auto").strip().lower()
        self.fal_key = (fal_key or "").strip()
        self.fal_endpoint_url = fal_endpoint_url
        self.fal_timeout_seconds = fal_timeout_seconds
        self.lookbook_vton_timeout_seconds = max(6.0, float(lookbook_vton_timeout_seconds))

        if provider is not None:
            self.provider: VTONProvider = provider
        else:
            effective_name = (
                "auto" if self.vton_provider in ("", "mock") else self.vton_provider
            )
            self.provider = get_vton_provider(
                effective_name,
                fal_key=self.fal_key,
                fal_catvton_url=self.fal_endpoint_url,
                fal_timeout_seconds=min(self.fal_timeout_seconds, 14.0),
                hf_token=hf_token,
                hf_vton_enabled=hf_vton_enabled,
                hf_vton_timeout_seconds=min(hf_vton_timeout_seconds, 8.0),
                total_timeout_seconds=14.0 if self.fal_key else self.lookbook_vton_timeout_seconds,
            )

    @staticmethod
    def list_virtual_models() -> list[dict[str, Any]]:
        return [m.as_dict() for m in VIRTUAL_STUDIO_MODELS]

    @staticmethod
    def _resolve_model_portrait_path(model: VirtualStudioModel) -> Path | None:
        candidates = [
            (STOREFRONT_PUBLIC_DIR / model.portrait_rel_path).resolve(),
            (TRYON_MODELS_DIR / "vn-model-balanced-s.webp").resolve(),
            (TRYON_MODELS_DIR / "vn-model-petite-xs.webp").resolve(),
            (TRYON_MODELS_DIR / "vn-model-tall-m.webp").resolve(),
            (TRYON_MODELS_DIR / "vn-model-curvy-l.webp").resolve(),
        ]
        for candidate in candidates:
            if candidate.is_file():
                return candidate
        return None

    async def _load_model_portrait_bytes(self, model: VirtualStudioModel) -> bytes | None:
        portrait_path = self._resolve_model_portrait_path(model)
        if portrait_path is None:
            return None
        try:
            data = await asyncio.to_thread(portrait_path.read_bytes)
            return data if data and len(data) > 128 else None
        except Exception as exc:
            logger.warning("Failed to read studio portrait %s: %s", portrait_path, exc)
            return None

    def _load_manifest_garment_bytes(self, product_id: str) -> tuple[bytes | None, str | None]:
        processed_dir = REPO_ROOT / "infra" / "seeds" / "real-assets-cache" / "processed"
        manifest_path = processed_dir / "manifest.json"
        if not manifest_path.is_file():
            return None, None
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            products_map = manifest.get("products") or {}
            if not isinstance(products_map, dict):
                return None, None
            entry = products_map.get(product_id.strip())
            if isinstance(entry, dict):
                rel = entry.get("tryonFlat") or entry.get("rackFront")
                if rel:
                    asset_path = processed_dir / str(rel)
                    if asset_path.is_file():
                        return asset_path.read_bytes(), str(asset_path)
            # Fallback to first real processed flat-lay asset on disk if ID is synthetic
            for item in products_map.values():
                if not isinstance(item, dict):
                    continue
                rel = item.get("tryonFlat") or item.get("rackFront")
                if rel:
                    asset_path = processed_dir / str(rel)
                    if asset_path.is_file():
                        return asset_path.read_bytes(), str(asset_path)
        except Exception:
            pass
        return None, None

    async def _fetch_bytes_from_source(self, source: str) -> bytes | None:
        cleaned = (source or "").strip()
        if not cleaned:
            return None

        if cleaned.lower().startswith("data:") and "," in cleaned:
            try:
                raw = base64.b64decode(cleaned.split(",", 1)[1].strip())
                return raw if raw and len(raw) > 128 else None
            except Exception:
                return None

        if cleaned.startswith("/"):
            rel_path = cleaned.split("?", 1)[0].lstrip("/")
            try:
                candidate = (STOREFRONT_PUBLIC_DIR / rel_path).resolve()
                candidate.relative_to(STOREFRONT_PUBLIC_DIR.resolve())
                if candidate.is_file():
                    data = await asyncio.to_thread(candidate.read_bytes)
                    if data and len(data) > 128:
                        return data
            except Exception:
                pass
            cleaned = f"http://127.0.0.1:3000{cleaned}"

        if cleaned.startswith("minio://"):
            parsed = urlparse(cleaned)
            bucket = parsed.netloc
            key = parsed.path.lstrip("/")
            if bucket and key:
                try:
                    data = await self.minio.get_object_bytes(bucket=bucket, key=key)
                    if data and len(data) > 128:
                        return data
                except Exception:
                    pass
            return None

        # Local filesystem path (used in tests or local asset pipelines)
        if not cleaned.startswith(("http://", "https://")):
            try:
                local_path = Path(cleaned)
                if local_path.is_file():
                    data = await asyncio.to_thread(local_path.read_bytes)
                    if data and len(data) > 128:
                        return data
            except Exception:
                pass
            return None

        fetch_url = cleaned.replace("http://localhost:", "http://127.0.0.1:")
        try:
            async with httpx.AsyncClient(timeout=4.0, follow_redirects=True) as client:
                r = await client.get(fetch_url)
                if r.status_code == 200 and r.content and len(r.content) > 128:
                    return r.content
        except Exception:
            pass

        # Direct MinIO bucket fallback if URL points at a known MinIO bucket
        parsed = urlparse(fetch_url)
        parts = [p for p in parsed.path.lstrip("/").split("/") if p]
        if len(parts) >= 2 and parts[0] in (
            self.minio.garments_bucket,
            self.minio.public_bucket,
            self.minio.private_bucket,
        ):
            try:
                data = await self.minio.get_object_bytes(
                    bucket=parts[0],
                    key="/".join(parts[1:]),
                )
                if data and len(data) > 128:
                    return data
            except Exception:
                pass

        return None

    async def _fetch_garment_bytes(
        self,
        *,
        garment_image_url: str | None,
        product_id: str,
        variant_id: str | None,
    ) -> tuple[bytes | None, str | None]:
        resolved_url = garment_image_url.strip() if garment_image_url else None
        if not resolved_url:
            try:
                async with httpx.AsyncClient(timeout=2.5) as client:
                    resp = await client.get(
                        f"{self.catalog_url}/v1/catalog/products",
                        params={"pageSize": 50},
                    )
                    if resp.status_code == 200:
                        data = resp.json().get("data")
                        items = data.get("items", []) if isinstance(data, dict) else []
                        for prod in items:
                            if not isinstance(prod, dict):
                                continue
                            if str(prod.get("id") or "") != product_id and str(prod.get("slug") or "") != product_id:
                                continue
                            resolved_url = (
                                prod.get("tryonFlatAssetUrl")
                                or prod.get("primaryImageUrl")
                            )
                            for var in prod.get("variants") or []:
                                if not isinstance(var, dict):
                                    continue
                                if variant_id and str(var.get("id") or "") == variant_id:
                                    resolved_url = (
                                        var.get("tryonFlatPreviewUrl")
                                        or var.get("rackFrontUrl")
                                        or var.get("lookbookMainUrl")
                                        or resolved_url
                                    )
                                    break
                                if not resolved_url:
                                    resolved_url = (
                                        var.get("tryonFlatPreviewUrl")
                                        or var.get("rackFrontUrl")
                                        or var.get("lookbookMainUrl")
                                    )
                            break
            except Exception:
                pass

        if resolved_url:
            fetched = await self._fetch_bytes_from_source(resolved_url)
            if fetched:
                return fetched, resolved_url

        manifest_bytes, manifest_path = await asyncio.to_thread(
            self._load_manifest_garment_bytes,
            product_id,
        )
        if manifest_bytes:
            return manifest_bytes, resolved_url or manifest_path

        return None, resolved_url

    async def generate_lookbook(
        self,
        *,
        product_id: str,
        virtual_model_code: str,
        scene_prompt: str,
        variant_id: str | None = None,
        garment_image_url: str | None = None,
        garment_bytes: bytes | None = None,
        product_name: str | None = None,
    ) -> LookbookGenerateResult:
        model = VIRTUAL_STUDIO_MODELS_BY_CODE.get(virtual_model_code)
        if model is None:
            raise ValueError(
                f"Unknown virtualModelCode '{virtual_model_code}'. "
                f"Allowed: {', '.join(VIRTUAL_STUDIO_MODELS_BY_CODE.keys())}"
            )

        resolved_garment_url = garment_image_url.strip() if garment_image_url else None
        if garment_bytes is None:
            garment_bytes, resolved_garment_url = await self._fetch_garment_bytes(
                garment_image_url=garment_image_url,
                product_id=product_id,
                variant_id=variant_id,
            )

        portrait_bytes = await self._load_model_portrait_bytes(model)
        cloth_type = _infer_cloth_type(product_name, scene_prompt)
        lighting_preset = _infer_lighting_preset(model, scene_prompt)

        webp_bytes: bytes | None = None
        out_width = LOOKBOOK_WIDTH
        out_height = LOOKBOOK_HEIGHT
        provider_used = "PILLOW_LAST_RESORT_FALLBACK"
        provider_badge = get_provider_display_badge("SMART_POSE_WARP")

        # Primary path: Real Multi-Tier AutoVTONProvider (FAL_CATVTON -> FASHN -> LAN GPU -> HF_GRADIO -> PhotometricInpaint/SmartPoseWarp)
        if portrait_bytes is not None:
            try:
                effective_garment_bytes = garment_bytes
                if effective_garment_bytes is None:
                    fallback_img = _build_fallback_garment(
                        512,
                        680,
                        _infer_scene_darkness(model, scene_prompt),
                    )
                    g_buf = io.BytesIO()
                    fallback_img.save(g_buf, format="PNG")
                    effective_garment_bytes = g_buf.getvalue()

                vton_timeout = 14.0 if self.fal_key else self.lookbook_vton_timeout_seconds
                gen_req = TryOnGenerationRequest(
                    person_bytes=portrait_bytes,
                    garment_bytes=effective_garment_bytes,
                    garment_image_url=(
                        resolved_garment_url
                        if resolved_garment_url
                        and resolved_garment_url.startswith(("http://", "https://"))
                        else None
                    ),
                    cloth_type=cloth_type,
                    garment_name=(product_name or product_id or "luxury garment").strip(),
                    lighting_preset=lighting_preset,
                    step_order=1,
                    total_steps=1,
                    timeout_seconds=vton_timeout,
                )
                gen_res = await self.provider.generate(gen_req)
                raw_bytes = getattr(gen_res, "result_bytes", None)
                if raw_bytes and len(raw_bytes) > 128:
                    webp_bytes, out_width, out_height = await asyncio.to_thread(
                        _normalize_webp_768x1024,
                        raw_bytes,
                    )
                    provider_used = _normalize_lookbook_provider_used(
                        getattr(gen_res, "provider_used", None),
                        getattr(gen_res, "provider_type", None),
                    )
                    provider_badge = str(
                        getattr(gen_res, "provider_badge", None)
                        or get_provider_display_badge(provider_used)
                    )
            except Exception as exc:
                logger.warning(
                    "All AutoVTONProvider tiers failed for lookbook (%s: %s); using PILLOW_LAST_RESORT_FALLBACK",
                    exc.__class__.__name__,
                    str(exc)[:220],
                )
                webp_bytes = None

        # Last-resort Pillow 2D fallback ONLY when every VTON tier failed or portrait missing
        if webp_bytes is None:
            webp_bytes = await asyncio.to_thread(
                _render_editorial_lookbook_sync,
                model=model,
                scene_prompt=scene_prompt,
                garment_bytes=garment_bytes,
            )
            out_width = LOOKBOOK_WIDTH
            out_height = LOOKBOOK_HEIGHT
            provider_used = "PILLOW_LAST_RESORT_FALLBACK"
            provider_badge = get_provider_display_badge("MOCK")

        lookbook_id = str(uuid4())
        safe_product_id = re.sub(r"[^a-zA-Z0-9_-]", "-", product_id.strip())[:80] or "product"
        object_key = f"lookbooks/{safe_product_id}/{lookbook_id}.webp"
        public_bucket = self.minio.public_bucket

        await self.minio.ensure_buckets()
        await self.minio.put_object_bytes(
            bucket=public_bucket,
            key=object_key,
            data=webp_bytes,
            content_type="image/webp",
        )

        result_url = f"{self.minio.endpoint_url}/{public_bucket}/{object_key}"

        try:
            async with httpx.AsyncClient(timeout=2.5) as client:
                verify_resp = await client.get(result_url)
                if verify_resp.status_code != 200:
                    logger.warning(
                        "Public lookbook readability check returned HTTP %d for %s",
                        verify_resp.status_code,
                        result_url,
                    )
        except Exception as exc:
            logger.warning(
                "Public lookbook readability check skipped (%s)",
                exc.__class__.__name__,
            )

        return LookbookGenerateResult(
            lookbook_id=lookbook_id,
            product_id=product_id,
            variant_id=variant_id,
            virtual_model_code=model.code,
            scene_prompt=scene_prompt,
            bucket=public_bucket,
            object_key=object_key,
            result_url=result_url,
            provider_used=provider_used,
            provider_badge=provider_badge,
            width=out_width,
            height=out_height,
            status="NHAP_AI",
            auto_attach=False,
            auto_attach_as_tryon_garment=False,
            requires_human_approval=True,
            created_at=utcnow().isoformat(),
        )
