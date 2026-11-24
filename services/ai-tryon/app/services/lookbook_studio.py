from __future__ import annotations

import asyncio
import base64
import io
import logging
import re
from dataclasses import dataclass
from typing import Any, Literal
from uuid import uuid4

import httpx
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

from app.db.models import utcnow
from app.storage.minio_client import MinioStorageClient

logger = logging.getLogger("atelier.ai_tryon.lookbook_studio")

LOOKBOOK_WIDTH = 960
LOOKBOOK_HEIGHT = 1280


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
        is_dark_scene=True,
    ),
    VirtualStudioModel(
        code="MODEL_EDITORIAL_UNISEX_01",
        display_name="Tầm Xuân Editorial · Warm Ivory Studio (1m75)",
        height_cm=175,
        weight_kg=None,
        gender="UNISEX",
        vibe="Nghệ thuật triển lãm · Phông nền ngà tinh giản Quiet Luxury",
        studio_backdrop="Gallery Warm Ivory Backdrop",
        palette=("#FAF5EC", "#ECE1CE", "#B08A4A"),
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
    """Generate a clean, watermark-free 960x1280 (3:4) Quiet Luxury Lookbook WebP."""
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

    # 1. Warm radial editorial key light + subtle studio arch
    light_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ldraw = ImageDraw.Draw(light_layer)
    spot_color = (235, 207, 143, 62) if is_dark else (255, 250, 240, 120)
    ldraw.ellipse([int(w * 0.08), int(h * 0.05), int(w * 0.92), int(h * 0.72)], fill=spot_color)
    light_layer = light_layer.filter(ImageFilter.GaussianBlur(radius=68))
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

    # 2. Refined editorial studio model silhouette tailored to model gender & height
    figure_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    fdraw = ImageDraw.Draw(figure_layer)
    cx = w // 2
    shoulder_half = 132 if model.gender == "MALE" else (106 if model.gender == "FEMALE" else 118)
    hip_half = 104 if model.gender == "MALE" else (112 if model.gender == "FEMALE" else 108)

    # Soft studio floor shadow
    fdraw.ellipse(
        [cx - 175, int(h * 0.88), cx + 175, int(h * 0.93)],
        fill=(28, 20, 16, 75 if not is_dark else 135),
    )

    # Hair / head silhouette
    head_r = 58
    head_cy = int(h * 0.175)
    if model.gender == "FEMALE":
        fdraw.ellipse(
            [cx - head_r - 12, head_cy - head_r - 8, cx + head_r + 12, head_cy + head_r + 48],
            fill=hair_rgba,
        )
    else:
        fdraw.ellipse(
            [cx - head_r - 4, head_cy - head_r - 10, cx + head_r + 4, head_cy + int(head_r * 0.4)],
            fill=hair_rgba,
        )
    fdraw.ellipse(
        [cx - head_r, head_cy - head_r, cx + head_r, head_cy + head_r],
        fill=skin_rgba,
    )
    # Neck
    fdraw.rectangle(
        [cx - 24, head_cy + head_r - 8, cx + 24, int(h * 0.255)],
        fill=skin_rgba,
    )
    # Torso + arms + lower silhouette
    body_poly = [
        (cx - shoulder_half, int(h * 0.255)),
        (cx + shoulder_half, int(h * 0.255)),
        (cx + shoulder_half + 36, int(h * 0.56)),
        (cx + hip_half + 12, int(h * 0.58)),
        (cx + hip_half, int(h * 0.89)),
        (cx + 16, int(h * 0.89)),
        (cx, int(h * 0.62)),
        (cx - 16, int(h * 0.89)),
        (cx - hip_half, int(h * 0.89)),
        (cx - hip_half - 12, int(h * 0.58)),
        (cx - shoulder_half - 36, int(h * 0.56)),
    ]
    base_suit_rgba = (54, 42, 35, 225) if not is_dark else (228, 218, 202, 210)
    fdraw.polygon(body_poly, fill=base_suit_rgba)
    figure_layer = figure_layer.filter(ImageFilter.GaussianBlur(radius=0.8))
    canvas = Image.alpha_composite(canvas, figure_layer)

    # 3. Composite fetched garment flat-lay cleanly onto model torso/drape
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

    # Natural contact shadow behind garment
    shadow_alpha = overlay.getchannel("A").point(lambda px: int(px * 0.30))
    shadow = Image.new("RGBA", overlay.size, (20, 14, 10, 255))
    shadow.putalpha(shadow_alpha)
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=10))
    shadow_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    shadow_layer.paste(shadow, (paste_x + 6, paste_y + 12), shadow)
    canvas = Image.alpha_composite(canvas, shadow_layer)

    # Soft feathered edge blending
    edge_mask = Image.new("L", overlay.size, 255)
    edraw = ImageDraw.Draw(edge_mask)
    edraw.rectangle([0, 0, overlay.width - 1, overlay.height - 1], outline=110, width=4)
    edge_mask = edge_mask.filter(ImageFilter.GaussianBlur(radius=2))
    blended_alpha = ImageChops.multiply(overlay.getchannel("A"), edge_mask)
    overlay.putalpha(blended_alpha)

    garment_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    garment_layer.paste(overlay, (paste_x, paste_y), overlay)
    canvas = Image.alpha_composite(canvas, garment_layer)

    # 4. Subtle editorial vignette (watermark-free studio finish)
    vignette = Image.new("RGBA", (w, h), (28, 20, 16, 48 if not is_dark else 86))
    vmask = Image.new("L", (w, h), 255)
    vdraw = ImageDraw.Draw(vmask)
    vdraw.ellipse(
        [int(w * 0.04), int(h * 0.03), int(w * 0.96), int(h * 0.97)],
        fill=0,
    )
    vmask = vmask.filter(ImageFilter.GaussianBlur(radius=95))
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
    provider_used: Literal["MOCK", "FAL_CATVTON"]
    width: int
    height: int
    created_at: str

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
            "width": self.width,
            "height": self.height,
            "createdAt": self.created_at,
        }


class LookbookStudioService:
    """AI Lookbook Studio: 5 virtual models -> 960x1280 editorial WebP on `atelier-public`."""

    def __init__(
        self,
        *,
        minio: MinioStorageClient,
        catalog_url: str = "http://127.0.0.1:4002",
        vton_provider: str = "mock",
        fal_key: str = "",
        fal_endpoint_url: str = "https://queue.fal.run/fal-ai/cat-vton",
        fal_timeout_seconds: float = 45.0,
    ) -> None:
        self.minio = minio
        self.catalog_url = catalog_url.rstrip("/")
        self.vton_provider = (vton_provider or "mock").strip().lower()
        self.fal_key = (fal_key or "").strip()
        self.fal_endpoint_url = fal_endpoint_url
        self.fal_timeout_seconds = fal_timeout_seconds

    @staticmethod
    def list_virtual_models() -> list[dict[str, Any]]:
        return [m.as_dict() for m in VIRTUAL_STUDIO_MODELS]

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
                            if str(prod.get("id") or "") != product_id:
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

        if resolved_url and (
            resolved_url.startswith("http://") or resolved_url.startswith("https://")
        ):
            try:
                async with httpx.AsyncClient(timeout=3.5) as client:
                    r = await client.get(resolved_url)
                    if r.status_code == 200 and r.content:
                        return r.content, resolved_url
            except Exception:
                pass

        return None, resolved_url

    async def _try_fal_lookbook(
        self,
        *,
        base_lookbook_webp: bytes,
        garment_url: str | None,
        garment_bytes: bytes | None,
        scene_prompt: str,
    ) -> bytes | None:
        if self.vton_provider != "fal" or not self.fal_key:
            return None
        try:
            human_uri = (
                "data:image/webp;base64,"
                + base64.b64encode(base_lookbook_webp).decode("ascii")
            )
            garment_input = garment_url or (
                "data:image/webp;base64,"
                + base64.b64encode(garment_bytes).decode("ascii")
                if garment_bytes
                else None
            )
            if not garment_input:
                return None
            async with httpx.AsyncClient(timeout=self.fal_timeout_seconds) as client:
                resp = await client.post(
                    self.fal_endpoint_url,
                    headers={
                        "Authorization": f"Key {self.fal_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "human_image_url": human_uri,
                        "garment_image_url": garment_input,
                        "cloth_type": "overall",
                        "prompt": scene_prompt,
                    },
                )
                if resp.status_code >= 400:
                    return None
                data = resp.json()
                img_url = (
                    (data.get("image") or {}).get("url")
                    if isinstance(data.get("image"), dict)
                    else data.get("image_url")
                )
                if not img_url:
                    return None
                img_resp = await client.get(str(img_url))
                if img_resp.status_code != 200 or not img_resp.content:
                    return None
                # Normalize returned fal output to 960x1280 WebP
                with Image.open(io.BytesIO(img_resp.content)) as im:
                    fitted = ImageOps.fit(
                        im.convert("RGB"),
                        (LOOKBOOK_WIDTH, LOOKBOOK_HEIGHT),
                        method=Image.Resampling.LANCZOS,
                    )
                    out = io.BytesIO()
                    fitted.save(out, format="WEBP", quality=90, method=4)
                    return out.getvalue()
        except Exception as exc:
            logger.warning(
                "fal.ai lookbook generation failed (%s); falling back to Pillow studio render",
                exc.__class__.__name__,
            )
            return None

    async def generate_lookbook(
        self,
        *,
        product_id: str,
        virtual_model_code: str,
        scene_prompt: str,
        variant_id: str | None = None,
        garment_image_url: str | None = None,
        product_name: str | None = None,
    ) -> LookbookGenerateResult:
        del product_name  # Editorial lookbook output is watermark-free
        model = VIRTUAL_STUDIO_MODELS_BY_CODE.get(virtual_model_code)
        if model is None:
            raise ValueError(
                f"Unknown virtualModelCode '{virtual_model_code}'. "
                f"Allowed: {', '.join(VIRTUAL_STUDIO_MODELS_BY_CODE.keys())}"
            )

        garment_bytes, resolved_garment_url = await self._fetch_garment_bytes(
            garment_image_url=garment_image_url,
            product_id=product_id,
            variant_id=variant_id,
        )

        webp_bytes = await asyncio.to_thread(
            _render_editorial_lookbook_sync,
            model=model,
            scene_prompt=scene_prompt,
            garment_bytes=garment_bytes,
        )
        provider_used: Literal["MOCK", "FAL_CATVTON"] = "MOCK"

        if self.vton_provider == "fal" and self.fal_key:
            fal_bytes = await self._try_fal_lookbook(
                base_lookbook_webp=webp_bytes,
                garment_url=resolved_garment_url,
                garment_bytes=garment_bytes,
                scene_prompt=scene_prompt,
            )
            if fal_bytes:
                webp_bytes = fal_bytes
                provider_used = "FAL_CATVTON"

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

        # Verify public URL is immediately readable (200 OK)
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
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
            width=LOOKBOOK_WIDTH,
            height=LOOKBOOK_HEIGHT,
            created_at=utcnow().isoformat(),
        )
