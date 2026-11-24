from __future__ import annotations

import io
import struct
from dataclasses import dataclass, field
from typing import Literal, Sequence

from PIL import Image, ImageOps

AspectRatioPreset = Literal["2:3", "3:4"]

ASPECT_RATIO_SPECS: dict[AspectRatioPreset, dict[str, float | int]] = {
    "2:3": {
        "ratio": 2.0 / 3.0,
        "target_width": 720,
        "target_height": 1080,
        "min_width": 480,
        "min_height": 720,
    },
    "3:4": {
        "ratio": 3.0 / 4.0,
        "target_width": 768,
        "target_height": 1024,
        "min_width": 480,
        "min_height": 640,
    },
}

ALLOWED_UPLOAD_CONTENT_TYPES: dict[str, str] = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}


@dataclass(frozen=True)
class ImageHeaderInfo:
    """Lightweight image header inspection result (PNG, JPEG & WebP)."""

    format: Literal["PNG", "WEBP", "JPEG", "UNKNOWN"]
    width: int
    height: int
    has_alpha: bool


@dataclass(frozen=True)
class MagicBytesCheckResult:
    valid: bool
    detected_mime: str | None
    extension: str | None
    width: int = 0
    height: int = 0
    error: str | None = None


@dataclass(frozen=True)
class GarmentValidationResult:
    """Result of garment aspect-ratio and alpha-channel checks."""

    valid: bool
    width: int
    height: int
    actual_ratio: float
    matched_preset: AspectRatioPreset | None
    has_alpha: bool
    errors: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class NormalizationPlan:
    """Target canvas geometry and safe-margin anchor plan for VTON preprocessing."""

    preset: AspectRatioPreset
    target_width: int
    target_height: int
    safe_margin_ratio: float
    hanger_anchor_x: float
    hanger_anchor_y: float
    preserve_alpha: bool


def validate_magic_bytes(payload: bytes) -> MagicBytesCheckResult:
    """Strictly validate JPEG, PNG, or WebP magic bytes + Pillow structural integrity."""
    if not payload or len(payload) < 12:
        return MagicBytesCheckResult(
            valid=False,
            detected_mime=None,
            extension=None,
            error="Uploaded payload is empty or too short to be a valid image.",
        )

    detected_mime: str | None = None
    extension: str | None = None

    if payload[:3] == b"\xff\xd8\xff":
        detected_mime = "image/jpeg"
        extension = "jpg"
    elif payload[:8] == b"\x89PNG\r\n\x1a\n":
        detected_mime = "image/png"
        extension = "png"
    elif payload[:4] == b"RIFF" and payload[8:12] == b"WEBP":
        detected_mime = "image/webp"
        extension = "webp"
    else:
        return MagicBytesCheckResult(
            valid=False,
            detected_mime=None,
            extension=None,
            error=(
                "Invalid image Magic Bytes: only authentic JPEG (FF D8 FF), "
                "PNG (89 50 4E 47 0D 0A 1A 0A), and WebP (RIFF....WEBP) files are accepted."
            ),
        )

    try:
        with Image.open(io.BytesIO(payload)) as img:
            img.verify()
        with Image.open(io.BytesIO(payload)) as img:
            width, height = img.size
            if width <= 0 or height <= 0:
                return MagicBytesCheckResult(
                    valid=False,
                    detected_mime=None,
                    extension=None,
                    error="Image dimensions must be positive.",
                )
            return MagicBytesCheckResult(
                valid=True,
                detected_mime=detected_mime,
                extension=extension,
                width=width,
                height=height,
            )
    except Exception as exc:
        return MagicBytesCheckResult(
            valid=False,
            detected_mime=None,
            extension=None,
            error=f"Corrupted or spoofed image payload ({exc.__class__.__name__}).",
        )


def normalize_user_portrait_3x4(
    payload: bytes,
    *,
    target_size: tuple[int, int] = (768, 1024),
) -> Image.Image:
    """Decode, EXIF-orient, and center-fit a user portrait into a clean 768x1024 RGBA canvas."""
    with Image.open(io.BytesIO(payload)) as raw_img:
        transposed = ImageOps.exif_transpose(raw_img)
        rgba = transposed.convert("RGBA")
        fitted = ImageOps.fit(
            rgba,
            target_size,
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.35),
        )
        return fitted


def inspect_image_bytes(payload: bytes) -> ImageHeaderInfo:
    """Parse PNG, WebP, or JPEG headers to extract dimensions & alpha flag."""
    if len(payload) >= 26 and payload[:8] == b"\x89PNG\r\n\x1a\n":
        if payload[12:16] == b"IHDR":
            width, height = struct.unpack(">II", payload[16:24])
            color_type = payload[25]
            has_alpha = color_type in (4, 6) or (b"tRNS" in payload[:4096])
            return ImageHeaderInfo(
                format="PNG",
                width=width,
                height=height,
                has_alpha=has_alpha,
            )

    if len(payload) >= 30 and payload[:4] == b"RIFF" and payload[8:12] == b"WEBP":
        chunk_type = payload[12:16]
        if chunk_type == b"VP8X":
            flags = payload[20]
            has_alpha = bool(flags & 0x10)
            width = 1 + int.from_bytes(payload[24:27], "little")
            height = 1 + int.from_bytes(payload[27:30], "little")
            return ImageHeaderInfo(
                format="WEBP",
                width=width,
                height=height,
                has_alpha=has_alpha,
            )
        if chunk_type == b"VP8L" and len(payload) >= 25:
            bits = struct.unpack("<I", payload[21:25])[0]
            width = (bits & 0x3FFF) + 1
            height = ((bits >> 14) & 0x3FFF) + 1
            has_alpha = bool((bits >> 28) & 0x1)
            return ImageHeaderInfo(
                format="WEBP",
                width=width,
                height=height,
                has_alpha=has_alpha,
            )
        if chunk_type == b"VP8 " and len(payload) >= 30:
            raw_w, raw_h = struct.unpack("<HH", payload[26:30])
            return ImageHeaderInfo(
                format="WEBP",
                width=raw_w & 0x3FFF,
                height=raw_h & 0x3FFF,
                has_alpha=False,
            )

    if len(payload) >= 3 and payload[:3] == b"\xff\xd8\xff":
        try:
            with Image.open(io.BytesIO(payload)) as img:
                return ImageHeaderInfo(
                    format="JPEG",
                    width=img.width,
                    height=img.height,
                    has_alpha=False,
                )
        except Exception:
            pass

    return ImageHeaderInfo(format="UNKNOWN", width=0, height=0, has_alpha=False)


class GarmentNormalizer:
    """Validates garment cutouts against Atelier 2:3 / 3:4 aspect & alpha rules."""

    def __init__(self, ratio_tolerance: float = 0.035) -> None:
        self.ratio_tolerance = ratio_tolerance

    def validate_dimensions(
        self,
        width: int,
        height: int,
        *,
        has_alpha: bool = True,
        require_alpha: bool = True,
        allowed_ratios: Sequence[AspectRatioPreset] = ("2:3", "3:4"),
    ) -> GarmentValidationResult:
        errors: list[str] = []
        if width <= 0 or height <= 0:
            return GarmentValidationResult(
                valid=False,
                width=width,
                height=height,
                actual_ratio=0.0,
                matched_preset=None,
                has_alpha=has_alpha,
                errors=["Image width and height must be positive integers."],
            )

        actual_ratio = round(width / height, 4)
        matched_preset: AspectRatioPreset | None = None
        best_delta = float("inf")

        for preset in allowed_ratios:
            spec = ASPECT_RATIO_SPECS[preset]
            target_ratio = float(spec["ratio"])
            delta = abs(actual_ratio - target_ratio) / target_ratio
            if delta <= self.ratio_tolerance and delta < best_delta:
                best_delta = delta
                matched_preset = preset

        if matched_preset is None:
            allowed_label = " or ".join(allowed_ratios)
            errors.append(
                f"Aspect ratio {width}x{height} ({actual_ratio:.4f}) does not match "
                f"allowed presets ({allowed_label}) within +/-{self.ratio_tolerance * 100:.1f}%."
            )
        else:
            spec = ASPECT_RATIO_SPECS[matched_preset]
            min_w = int(spec["min_width"])
            min_h = int(spec["min_height"])
            if width < min_w or height < min_h:
                errors.append(
                    f"Resolution {width}x{height} is below minimum {min_w}x{min_h} "
                    f"for preset {matched_preset}."
                )

        if require_alpha and not has_alpha:
            errors.append(
                "Garment cutout must include an alpha transparency channel (WebP VP8X / RGBA PNG)."
            )

        return GarmentValidationResult(
            valid=len(errors) == 0,
            width=width,
            height=height,
            actual_ratio=actual_ratio,
            matched_preset=matched_preset,
            has_alpha=has_alpha,
            errors=errors,
        )

    def validate_bytes(
        self,
        payload: bytes,
        *,
        require_alpha: bool = True,
        allowed_ratios: Sequence[AspectRatioPreset] = ("2:3", "3:4"),
    ) -> GarmentValidationResult:
        info = inspect_image_bytes(payload)
        if info.format == "UNKNOWN":
            return GarmentValidationResult(
                valid=False,
                width=0,
                height=0,
                actual_ratio=0.0,
                matched_preset=None,
                has_alpha=False,
                errors=["Unsupported image binary format; expected WebP or PNG."],
            )
        return self.validate_dimensions(
            info.width,
            info.height,
            has_alpha=info.has_alpha,
            require_alpha=require_alpha,
            allowed_ratios=allowed_ratios,
        )

    def build_normalization_plan(
        self,
        validation: GarmentValidationResult,
        *,
        default_preset: AspectRatioPreset = "2:3",
    ) -> NormalizationPlan:
        preset = validation.matched_preset or default_preset
        spec = ASPECT_RATIO_SPECS[preset]
        return NormalizationPlan(
            preset=preset,
            target_width=int(spec["target_width"]),
            target_height=int(spec["target_height"]),
            safe_margin_ratio=0.15,
            hanger_anchor_x=0.5,
            hanger_anchor_y=0.045,
            preserve_alpha=validation.has_alpha,
        )
