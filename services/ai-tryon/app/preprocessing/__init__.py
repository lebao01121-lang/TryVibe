"""Garment preprocessing, Magic Bytes validation, and Pillow 3:4 portrait normalization."""

from app.preprocessing.normalizer import (
    ALLOWED_UPLOAD_CONTENT_TYPES,
    ASPECT_RATIO_SPECS,
    AspectRatioPreset,
    GarmentNormalizer,
    GarmentValidationResult,
    ImageHeaderInfo,
    MagicBytesCheckResult,
    NormalizationPlan,
    inspect_image_bytes,
    normalize_user_portrait_3x4,
    validate_magic_bytes,
)

__all__ = [
    "ALLOWED_UPLOAD_CONTENT_TYPES",
    "ASPECT_RATIO_SPECS",
    "AspectRatioPreset",
    "GarmentNormalizer",
    "GarmentValidationResult",
    "ImageHeaderInfo",
    "MagicBytesCheckResult",
    "NormalizationPlan",
    "inspect_image_bytes",
    "normalize_user_portrait_3x4",
    "validate_magic_bytes",
]
