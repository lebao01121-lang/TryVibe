from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import time
from datetime import timedelta
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

import cv2
import numpy as np
from fastapi import APIRouter, Query, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import desc, func, select

from app.cache_quota.quota import TryOnCacheQuota, compute_session_cache_hash
from app.config import REPO_ROOT, Settings
from app.db.database import TryOnDatabase
from app.db.models import (
    SavedTryOnLook,
    TempUserImage,
    TryOnDemandEvent,
    TryOnJob,
    TryOnResult,
    TryOnSession,
    utcnow,
)
from app.preprocessing.normalizer import (
    ALLOWED_UPLOAD_CONTENT_TYPES,
    validate_magic_bytes,
)
from app.providers.base import VTONProvider, get_provider_display_badge
from app.services.lookbook_studio import (
    VIRTUAL_STUDIO_MODELS_BY_CODE,
    LookbookStudioService,
)
from app.storage.minio_client import MinioStorageClient
from app.tasks.auto_purge import TryOnAutoPurgeTask
from app.workers.consumer import TryOnQueuedTask, TryOnWorkerConsumer

MAX_UPLOAD_BYTES = 10 * 1024 * 1024

v1_router = APIRouter(prefix="/v1/tryon", tags=["ai-tryon-v1"])
internal_router = APIRouter(prefix="/internal/tryon", tags=["ai-tryon-internal"])


class TryOnApiError(Exception):
    """Structured domain error serialized into standard Atelier ApiResponse envelope."""

    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def build_api_response(
    data: Any,
    *,
    request: Request,
    status_code: int = 200,
) -> JSONResponse:
    correlation_id = getattr(request.state, "correlation_id", "")
    return JSONResponse(
        status_code=status_code,
        content={
            "success": True,
            "data": data,
            "error": None,
            "meta": {
                "correlationId": correlation_id,
                "timestamp": utcnow().isoformat(),
                "service": "ai-tryon",
            },
        },
    )


def build_api_error_response(
    *,
    status_code: int,
    code: str,
    message: str,
    request: Request,
    details: dict[str, Any] | None = None,
) -> JSONResponse:
    correlation_id = getattr(request.state, "correlation_id", "")
    err: dict[str, Any] = {"code": code, "message": message}
    if details:
        err["details"] = details
    return JSONResponse(
        status_code=status_code,
        content={
            "success": False,
            "data": None,
            "error": err,
            "meta": {
                "correlationId": correlation_id,
                "timestamp": utcnow().isoformat(),
                "service": "ai-tryon",
            },
        },
    )


def extract_caller_context(request: Request) -> tuple[str | None, str | None, str, str | None, str]:
    """Extract (user_id, guest_session_id, client_ip, loyalty_tier, owner_key) from headers."""
    headers = request.headers
    raw_user = (headers.get("x-user-id") or "").strip()
    user_id = raw_user or None

    raw_guest = (headers.get("x-guest-session-id") or "").strip()
    guest_session_id = raw_guest or None

    raw_tier = (headers.get("x-loyalty-tier") or "").strip().upper()
    loyalty_tier = raw_tier or None

    raw_ip = (headers.get("x-client-ip") or "").strip()
    if not raw_ip:
        xff = (headers.get("x-forwarded-for") or "").strip()
        if xff:
            raw_ip = xff.split(",")[0].strip()
    if not raw_ip and request.client and request.client.host:
        raw_ip = request.client.host
    client_ip = raw_ip or "127.0.0.1"

    if user_id:
        owner_key = f"user:{user_id}"
    elif guest_session_id:
        owner_key = f"guest:{guest_session_id}"
    else:
        owner_key = f"ip:{client_ip}"

    return user_id, guest_session_id, client_ip, loyalty_tier, owner_key


ADMIN_TRYON_ROLES = frozenset({"SUPER_ADMIN", "CATALOG_AI_OPERATOR"})


def is_privileged_tryon_caller(request: Request, settings: Settings) -> bool:
    """Allow trusted internal service calls or SUPER_ADMIN / CATALOG_AI_OPERATOR roles."""
    provided_secret = (request.headers.get("x-internal-secret") or "").strip()
    expected_secret = (settings.internal_service_secret or "").strip()
    if provided_secret and expected_secret and hmac.compare_digest(
        provided_secret, expected_secret
    ):
        return True

    raw_roles = (request.headers.get("x-actor-roles") or "").strip()
    if raw_roles:
        roles = {r.strip().upper() for r in raw_roles.split(",") if r.strip()}
        if roles & ADMIN_TRYON_ROLES:
            return True

    return False


def _get_services(
    request: Request,
) -> tuple[
    Settings,
    TryOnDatabase,
    MinioStorageClient,
    TryOnCacheQuota,
    VTONProvider,
    TryOnWorkerConsumer,
    TryOnAutoPurgeTask,
]:
    state = request.app.state
    return (
        state.settings,
        state.db,
        state.minio,
        state.cache_quota,
        state.provider,
        state.worker_consumer,
        state.auto_purge,
    )


# =============================================================================
# Request Models (matching packages/contracts/src/tryon.ts 1:1)
# =============================================================================


class UploadUrlRequestBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    content_type: str = Field(alias="contentType")
    file_size_bytes: int = Field(alias="fileSizeBytes")
    sha256_hash: str = Field(alias="sha256Hash", min_length=16, max_length=128)
    source: Literal["CAMERA_MEDIAPIPE", "STATIC_UPLOAD"] = "STATIC_UPLOAD"
    pose_score: float = Field(default=1.0, alias="poseScore", ge=0.0, le=1.0)
    privacy_consent: Any = Field(default=False, alias="privacyConsent")


class TryOnPosePointModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    visibility: float | None = Field(default=None, ge=0.0, le=1.0)


class TryOnFaceBoxModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    w: float = Field(ge=0.0, le=1.0)
    h: float = Field(ge=0.0, le=1.0)


class TryOnPoseLandmarksModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    nose: TryOnPosePointModel | None = None
    left_shoulder: TryOnPosePointModel | None = Field(default=None, alias="leftShoulder")
    right_shoulder: TryOnPosePointModel | None = Field(default=None, alias="rightShoulder")
    left_hip: TryOnPosePointModel | None = Field(default=None, alias="leftHip")
    right_hip: TryOnPosePointModel | None = Field(default=None, alias="rightHip")
    chin_y: float | None = Field(default=None, alias="chinY", ge=0.0, le=1.0)
    face_box: TryOnFaceBoxModel | None = Field(default=None, alias="faceBox")


class CreateSessionRequestBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    temp_image_id: str = Field(alias="tempImageId", min_length=1)
    object_key: str = Field(alias="objectKey", min_length=1)
    sha256_hash: str = Field(alias="sha256Hash", min_length=16, max_length=128)
    mode: Literal["SINGLE", "MIX_MATCH_OUTFIT"] = "SINGLE"
    upper_product_id: str | None = Field(default=None, alias="upperProductId")
    upper_variant_id: str | None = Field(default=None, alias="upperVariantId")
    lower_product_id: str | None = Field(default=None, alias="lowerProductId")
    lower_variant_id: str | None = Field(default=None, alias="lowerVariantId")
    one_piece_product_id: str | None = Field(default=None, alias="onePieceProductId")
    one_piece_variant_id: str | None = Field(default=None, alias="onePieceVariantId")
    pose_landmarks: TryOnPoseLandmarksModel | None = Field(default=None, alias="poseLandmarks")
    privacy_consent: Any = Field(default=False, alias="privacyConsent")
    simulate_failure: bool = Field(default=False, alias="simulateFailure")


class CreateBookmarkRequestBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    session_id: str = Field(alias="sessionId", min_length=1)
    upper_sku_id: str | None = Field(default=None, alias="upperSkuId")
    lower_sku_id: str | None = Field(default=None, alias="lowerSkuId")
    one_piece_sku_id: str | None = Field(default=None, alias="onePieceSkuId")
    label: str | None = Field(default=None, max_length=120)


class CreateSignalRequestBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    product_id: str = Field(alias="productId", min_length=1)
    sku_id: str | None = Field(default=None, alias="skuId")
    sku_code: str | None = Field(default=None, alias="skuCode")
    size_code: str | None = Field(default=None, alias="sizeCode")
    session_id: str | None = Field(default=None, alias="sessionId")
    signal_type: Literal[
        "OPEN_MODAL",
        "TRYON_COMPLETED",
        "SIZE_ADVISED",
        "ADD_TO_CART_AFTER_TRYON",
        "PURCHASE_AFTER_TRYON",
    ] | None = Field(default=None, alias="signalType")
    event_type: Literal[
        "OPEN_MODAL",
        "TRYON_COMPLETED",
        "SIZE_ADVISED",
        "ADD_TO_CART_AFTER_TRYON",
        "PURCHASE_AFTER_TRYON",
    ] | None = Field(default=None, alias="eventType")


class LookbookGenerateRequestBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    product_id: str = Field(alias="productId", min_length=1)
    variant_id: str | None = Field(default=None, alias="variantId")
    garment_image_url: str | None = Field(default=None, alias="garmentImageUrl")
    virtual_model_code: str = Field(alias="virtualModelCode", min_length=1)
    scene_prompt: str = Field(
        default="Warm Ivory Hanoi Atelier studio daylight, quiet luxury fashion editorial",
        alias="scenePrompt",
        min_length=1,
        max_length=500,
    )
    product_name: str | None = Field(default=None, alias="productName")


class TestExpireSessionBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    session_id: str | None = Field(default=None, alias="sessionId")
    temp_image_id: str | None = Field(default=None, alias="tempImageId")


class SeasonRestyleSelectionBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    slot_key: Literal["TOP", "BOTTOM", "ONE_PIECE", "OUTERWEAR", "ACCESSORY"] = Field(
        alias="slotKey"
    )
    product_id: str = Field(alias="productId", min_length=1)
    variant_id: str = Field(alias="variantId", min_length=1)
    color_hex: str = Field(alias="colorHex", min_length=4, max_length=16)
    color_key: str | None = Field(default=None, alias="colorKey")
    sheen: Literal["silk", "linen", "tweed", "leather"] | None = None


class SeasonRestyleRequestBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    selections: list[SeasonRestyleSelectionBody] = Field(min_length=1)
    combo_key: str | None = Field(default=None, alias="comboKey")
    hash: str | None = Field(default=None, alias="hash")


_SAFE_SEASON_SLUG_RE = re.compile(r"^[a-z0-9-]+$")
_SHA256_HEX_RE = re.compile(r"^[a-f0-9]{64}$")
_SEASON_LOOKBOOK_W = 960
_SEASON_LOOKBOOK_H = 1200

_DEFAULT_OPTICAL_PROFILES: dict[str, dict[str, Any]] = {
    "silk": {"sheen": "silk", "specularIntensity": 0.45, "shadowDepth": 0.34},
    "linen": {"sheen": "linen", "specularIntensity": 0.16, "shadowDepth": 0.28},
    "tweed": {"sheen": "tweed", "specularIntensity": 0.18, "shadowDepth": 0.38},
    "leather": {"sheen": "leather", "specularIntensity": 0.50, "shadowDepth": 0.35},
}

_SLOT_DEFAULT_SHEEN: dict[str, str] = {
    "TOP": "silk",
    "BOTTOM": "silk",
    "ONE_PIECE": "silk",
    "OUTERWEAR": "tweed",
    "ACCESSORY": "leather",
}

_SEASON_MANIFEST_CACHE: dict[str, Any] = {
    "path": None,
    "mtime": -1.0,
    "by_slug": {},
}


def _resolve_seasons_lookbook_dir() -> Path:
    primary = REPO_ROOT / "apps" / "storefront" / "public" / "seasons-lookbook"
    if primary.exists():
        return primary
    fallback = (
        REPO_ROOT / "infra" / "seeds" / "real-assets-cache" / "processed" / "seasons-lookbook"
    )
    if fallback.exists():
        return fallback
    return primary


def _load_seasons_manifest_map() -> dict[str, dict[str, Any]]:
    base_dir = _resolve_seasons_lookbook_dir()
    manifest_path = base_dir / "manifest.json"
    if not manifest_path.is_file():
        return _SEASON_MANIFEST_CACHE["by_slug"]
    try:
        mtime = manifest_path.stat().st_mtime
    except OSError:
        return _SEASON_MANIFEST_CACHE["by_slug"]

    if (
        _SEASON_MANIFEST_CACHE["path"] == str(manifest_path)
        and _SEASON_MANIFEST_CACHE["mtime"] == mtime
    ):
        return _SEASON_MANIFEST_CACHE["by_slug"]

    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        entries: list[dict[str, Any]] = []
        if isinstance(raw, list):
            entries = [e for e in raw if isinstance(e, dict)]
        elif isinstance(raw, dict):
            if isinstance(raw.get("seasons"), list):
                entries = [e for e in raw["seasons"] if isinstance(e, dict)]
            elif isinstance(raw.get("items"), list):
                entries = [e for e in raw["items"] if isinstance(e, dict)]
            else:
                for k, v in raw.items():
                    if isinstance(v, dict):
                        entries.append({"seasonSlug": v.get("seasonSlug") or v.get("slug") or k, **v})
        by_slug: dict[str, dict[str, Any]] = {}
        for item in entries:
            slug = str(item.get("seasonSlug") or item.get("slug") or "").strip().lower()
            if slug:
                by_slug[slug] = item
        _SEASON_MANIFEST_CACHE["path"] = str(manifest_path)
        _SEASON_MANIFEST_CACHE["mtime"] = mtime
        _SEASON_MANIFEST_CACHE["by_slug"] = by_slug
        return by_slug
    except Exception:
        return _SEASON_MANIFEST_CACHE["by_slug"]


def _parse_hex_rgb(hex_color: str) -> tuple[int, int, int]:
    cleaned = hex_color.strip().lstrip("#")
    if len(cleaned) == 3:
        cleaned = "".join(ch * 2 for ch in cleaned)
    if len(cleaned) != 6:
        return (23, 22, 21)
    try:
        return (
            int(cleaned[0:2], 16),
            int(cleaned[2:4], 16),
            int(cleaned[4:6], 16),
        )
    except ValueError:
        return (23, 22, 21)


def _resolve_slot_mask_and_profile(
    *,
    lookbook_dir: Path,
    season_slug: str,
    slot_key: str,
    explicit_sheen: str | None,
    manifest_season: dict[str, Any] | None,
) -> tuple[Path | None, dict[str, Any]]:
    slot_lower = slot_key.lower()
    default_sheen = explicit_sheen or _SLOT_DEFAULT_SHEEN.get(slot_key, "silk")
    profile = dict(_DEFAULT_OPTICAL_PROFILES.get(default_sheen, _DEFAULT_OPTICAL_PROFILES["silk"]))
    mask_path: Path | None = None

    if manifest_season and isinstance(manifest_season.get("wearableSlots"), list):
        for slot in manifest_season["wearableSlots"]:
            if not isinstance(slot, dict):
                continue
            if str(slot.get("slotKey") or "").upper() != slot_key:
                continue
            raw_profile = slot.get("materialOpticalProfile")
            if isinstance(raw_profile, dict):
                if not explicit_sheen and raw_profile.get("sheen") in _DEFAULT_OPTICAL_PROFILES:
                    profile["sheen"] = str(raw_profile["sheen"])
                if isinstance(raw_profile.get("specularIntensity"), (int, float)):
                    profile["specularIntensity"] = float(raw_profile["specularIntensity"])
                if isinstance(raw_profile.get("shadowDepth"), (int, float)):
                    profile["shadowDepth"] = float(raw_profile["shadowDepth"])
            raw_mask = str(slot.get("garmentRegionMask") or "").strip()
            if raw_mask:
                rel = raw_mask.lstrip("/")
                if rel.startswith("seasons-lookbook/"):
                    rel = rel[len("seasons-lookbook/") :]
                candidate = (lookbook_dir / rel).resolve()
                try:
                    candidate.relative_to(lookbook_dir.resolve())
                    if candidate.is_file():
                        mask_path = candidate
                except ValueError:
                    pass
            break

    if mask_path is None:
        for fname in (
            f"mask-{slot_lower}.png",
            f"mask-{slot_lower.replace('_', '-')}.png",
            f"mask-{slot_lower}.webp",
        ):
            candidate = lookbook_dir / season_slug / fname
            if candidate.is_file():
                mask_path = candidate
                break

    return mask_path, profile


def _apply_photometric_slot_recolor(
    working_bgr: np.ndarray,
    orig_lab: np.ndarray,
    mask_alpha: np.ndarray,
    *,
    color_hex: str,
    profile: dict[str, Any],
) -> np.ndarray:
    """Photometric CIE-LAB luminance + specular sheen + ambient context relighting."""
    active = mask_alpha > 0.04
    if not np.any(active):
        return working_bgr

    core = mask_alpha > 0.5
    if int(np.count_nonzero(core)) < 32:
        core = active

    tr, tg, tb = _parse_hex_rgb(color_hex)
    target_lab = cv2.cvtColor(np.uint8([[[tb, tg, tr]]]), cv2.COLOR_BGR2LAB)[0, 0].astype(
        np.float32
    )
    t_l, t_a, t_b = float(target_lab[0]), float(target_lab[1]), float(target_lab[2])

    sheen = str(profile.get("sheen") or "silk")
    specular = float(np.clip(profile.get("specularIntensity", 0.4), 0.0, 1.0))
    shadow_depth = float(np.clip(profile.get("shadowDepth", 0.34), 0.0, 1.0))

    l_orig = orig_lab[:, :, 0]
    a_orig = orig_lab[:, :, 1]
    b_orig = orig_lab[:, :, 2]

    # 1. Intrinsic shading & fold map relative to fabric median luminance
    l_p10, l_med, l_p92 = np.percentile(l_orig[core], [10, 50, 92])
    l_span = max(18.0, float(l_p92 - l_p10))
    rel = np.clip((l_orig - float(l_med)) / l_span, -1.65, 1.65)

    # 2. Material optical luminance + specular sheen response
    if t_l < 95.0:
        dark_factor = max(0.0, (95.0 - t_l) / 95.0)
        fold_amp = 24.0 + 18.0 * (1.0 - dark_factor) + 12.0 * shadow_depth
        ridge = np.power(np.clip((rel - 0.14) / 0.86, 0.0, 1.0), 1.6)
        sheen_gain = 46.0 if sheen == "silk" else (54.0 if sheen == "leather" else 18.0)
        sheen_lift = ridge * specular * sheen_gain
        chroma_atten = 1.0 - 0.34 * ridge * specular
    else:
        fold_amp = 38.0 + 16.0 * shadow_depth
        ridge = np.power(np.clip((rel - 0.22) / 0.78, 0.0, 1.0), 1.75)
        sheen_gain = 24.0 if sheen == "silk" else (28.0 if sheen == "leather" else 10.0)
        sheen_lift = ridge * specular * sheen_gain
        chroma_atten = 1.0 - 0.18 * ridge * specular

    # Preserve weave micro-texture for tweed & linen
    micro_detail = np.zeros_like(l_orig)
    if sheen in ("tweed", "linen"):
        blurred_l = cv2.GaussianBlur(l_orig, (7, 7), 0)
        micro_weight = 0.52 if sheen == "tweed" else 0.32
        micro_detail = (l_orig - blurred_l) * micro_weight

    l_new = np.clip(t_l + rel * fold_amp + sheen_lift + micro_detail, 4.0, 252.0)

    # 3. Context ambient relighting (7% chromatic bleed from surrounding scene light)
    mask_u8 = (mask_alpha > 0.12).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (19, 19))
    ring = (cv2.dilate(mask_u8, kernel, iterations=1) > 0) & (mask_u8 == 0)
    if int(np.count_nonzero(ring)) >= 32:
        amb_a = float(np.median(a_orig[ring]))
        amb_b = float(np.median(b_orig[ring]))
    else:
        amb_a = 128.0
        amb_b = 131.0

    ambient_weight = 0.07
    a_new = np.clip(
        128.0 + (t_a - 128.0) * chroma_atten * (1.0 - ambient_weight) + (amb_a - 128.0) * ambient_weight,
        1.0,
        254.0,
    )
    b_new = np.clip(
        128.0 + (t_b - 128.0) * chroma_atten * (1.0 - ambient_weight) + (amb_b - 128.0) * ambient_weight,
        1.0,
        254.0,
    )

    # 4. Soft contact edge ambient occlusion (subtle 3% shadow along feathered boundary)
    edge_band = np.clip(1.0 - np.abs(mask_alpha - 0.5) * 2.0, 0.0, 1.0)
    l_new = np.clip(l_new * (1.0 - 0.03 * edge_band), 4.0, 252.0)

    recolored_lab = np.stack([l_new, a_new, b_new], axis=-1).astype(np.uint8)
    recolored_bgr = cv2.cvtColor(recolored_lab, cv2.COLOR_LAB2BGR).astype(np.float32)

    alpha_3 = mask_alpha[:, :, None]
    return working_bgr * (1.0 - alpha_3) + recolored_bgr * alpha_3


def _render_season_restyle_sync(
    *,
    season_slug: str,
    selections: list[SeasonRestyleSelectionBody],
) -> bytes:
    lookbook_dir = _resolve_seasons_lookbook_dir()
    base_path = lookbook_dir / season_slug / "base.webp"
    if not base_path.is_file():
        raise FileNotFoundError(f"Base editorial image not found for season '{season_slug}'")

    base_raw = cv2.imread(str(base_path), cv2.IMREAD_COLOR)
    if base_raw is None or base_raw.size == 0:
        raise ValueError(f"Failed to decode base editorial image '{base_path}'")

    if base_raw.shape[1] != _SEASON_LOOKBOOK_W or base_raw.shape[0] != _SEASON_LOOKBOOK_H:
        base_bgr = cv2.resize(
            base_raw,
            (_SEASON_LOOKBOOK_W, _SEASON_LOOKBOOK_H),
            interpolation=cv2.INTER_LANCZOS4,
        )
    else:
        base_bgr = base_raw

    orig_lab = cv2.cvtColor(base_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    working_bgr = base_bgr.astype(np.float32)

    manifest_map = _load_seasons_manifest_map()
    manifest_season = manifest_map.get(season_slug)

    for sel in selections:
        mask_path, profile = _resolve_slot_mask_and_profile(
            lookbook_dir=lookbook_dir,
            season_slug=season_slug,
            slot_key=sel.slot_key,
            explicit_sheen=sel.sheen,
            manifest_season=manifest_season,
        )
        if mask_path is None:
            continue

        mask_img = cv2.imread(str(mask_path), cv2.IMREAD_UNCHANGED)
        if mask_img is None or mask_img.size == 0:
            continue

        if mask_img.ndim == 3 and mask_img.shape[2] == 4:
            alpha = mask_img[:, :, 3].astype(np.float32) / 255.0
        elif mask_img.ndim == 3:
            alpha = cv2.cvtColor(mask_img, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
        else:
            alpha = mask_img.astype(np.float32) / 255.0

        if alpha.shape[1] != _SEASON_LOOKBOOK_W or alpha.shape[0] != _SEASON_LOOKBOOK_H:
            alpha = cv2.resize(
                alpha,
                (_SEASON_LOOKBOOK_W, _SEASON_LOOKBOOK_H),
                interpolation=cv2.INTER_LINEAR,
            )

        alpha = np.clip(alpha, 0.0, 1.0)
        working_bgr = _apply_photometric_slot_recolor(
            working_bgr,
            orig_lab,
            alpha,
            color_hex=sel.color_hex,
            profile=profile,
        )

    out_u8 = np.clip(working_bgr, 0, 255).astype(np.uint8)
    ok, encoded = cv2.imencode(
        ".webp",
        out_u8,
        [int(cv2.IMWRITE_WEBP_QUALITY), 88],
    )
    if not ok:
        raise RuntimeError("Failed to encode seasonal restyle WebP output")
    return encoded.tobytes()


# =============================================================================
# 1. Privacy Gate, Dual Quota & Presigned PUT Upload
# =============================================================================


@v1_router.get("/quota")
async def get_quota(request: Request) -> JSONResponse:
    _, _, _, cache_quota, _, _, _ = _get_services(request)
    user_id, _, client_ip, loyalty_tier, _ = extract_caller_context(request)
    snap = await cache_quota.get_dual_quota(
        user_id=user_id,
        ip_address=client_ip,
        loyalty_tier=loyalty_tier,
    )
    return build_api_response(
        {
            "remainingQuota": snap.remaining_quota,
            "dailyLimit": snap.daily_limit,
            "usedToday": snap.used_today,
            "ipRemaining": snap.ip_remaining,
            "ipLimit": snap.ip_limit,
            "backend": snap.backend,
        },
        request=request,
    )


@v1_router.post("/upload-url")
async def create_upload_url(
    request: Request,
    body: UploadUrlRequestBody,
) -> JSONResponse:
    settings, db, minio, cache_quota, _, _, _ = _get_services(request)
    user_id, guest_session_id, client_ip, loyalty_tier, _ = extract_caller_context(request)

    if body.privacy_consent is not True:
        raise TryOnApiError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="PRIVACY_CONSENT_REQUIRED",
            message=(
                "Explicit privacyConsent=true is mandatory before uploading a portrait "
                "(15-minute hard auto-purge policy)."
            ),
        )

    ext = ALLOWED_UPLOAD_CONTENT_TYPES.get(body.content_type.strip().lower())
    if not ext:
        raise TryOnApiError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="VALIDATION_ERROR",
            message="Unsupported contentType. Allowed values: image/jpeg, image/png, image/webp.",
        )

    if body.file_size_bytes <= 0 or body.file_size_bytes > MAX_UPLOAD_BYTES:
        raise TryOnApiError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="VALIDATION_ERROR",
            message=f"fileSizeBytes must be between 1 and {MAX_UPLOAD_BYTES} bytes (10 MB).",
        )

    quota_snap = await cache_quota.get_dual_quota(
        user_id=user_id,
        ip_address=client_ip,
        loyalty_tier=loyalty_tier,
    )
    if not quota_snap.allowed:
        raise TryOnApiError(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code="QUOTA_EXCEEDED",
            message="Daily AI Try-On quota exhausted.",
            details={
                "reason": quota_snap.reason,
                "remainingQuota": quota_snap.remaining_quota,
                "dailyLimit": quota_snap.daily_limit,
                "ipRemaining": quota_snap.ip_remaining,
            },
        )

    now = utcnow()
    temp_image_id = str(uuid4())
    object_key = f"uploads/{temp_image_id}.{ext}"
    put_expires_at = now + timedelta(seconds=settings.tryon_presign_put_ttl_seconds)
    purge_at = now + timedelta(minutes=settings.tryon_purge_ttl_minutes)

    upload_url = await minio.generate_presigned_put_url(
        key=object_key,
        content_type=body.content_type.strip().lower(),
        expires_in=settings.tryon_presign_put_ttl_seconds,
    )

    async with db.session() as db_sess:
        db_sess.add(
            TempUserImage(
                id=temp_image_id,
                user_id=user_id,
                guest_session_id=guest_session_id,
                ip_address=client_ip,
                source=body.source,
                minio_object_key=object_key,
                sha256_hash=body.sha256_hash.strip().lower(),
                pose_score=float(body.pose_score),
                privacy_consent=True,
                expires_at=purge_at,
                is_purged=False,
                purged_at=None,
                created_at=now,
            )
        )
        await db_sess.commit()

    return build_api_response(
        {
            "uploadUrl": upload_url,
            "objectKey": object_key,
            "tempImageId": temp_image_id,
            "expiresAt": put_expires_at.isoformat(),
            "purgeAt": purge_at.isoformat(),
            "remainingQuota": quota_snap.remaining_quota,
            "dailyLimit": quota_snap.daily_limit,
        },
        request=request,
        status_code=status.HTTP_200_OK,
    )


# =============================================================================
# 2. Session Creation, Magic Bytes Verification, SHA-256 Cache Hit & Async Queue
# =============================================================================


@v1_router.post("/sessions")
async def create_session(
    request: Request,
    body: CreateSessionRequestBody,
) -> JSONResponse:
    started = time.perf_counter()
    settings, db, minio, cache_quota, provider, worker, _ = _get_services(request)
    user_id, guest_session_id, client_ip, loyalty_tier, _ = extract_caller_context(request)
    correlation_id = getattr(request.state, "correlation_id", "")

    if body.privacy_consent is not True:
        raise TryOnApiError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="PRIVACY_CONSENT_REQUIRED",
            message="Explicit privacyConsent=true is required to start an AI Try-On session.",
        )

    async with db.session() as db_sess:
        temp_img = await db_sess.get(TempUserImage, body.temp_image_id)
        if temp_img is None or temp_img.is_purged:
            raise TryOnApiError(
                status_code=status.HTTP_404_NOT_FOUND,
                code="NOT_FOUND",
                message="Temporary portrait image not found or already purged.",
            )
        object_key = temp_img.minio_object_key

    # Download uploaded bytes from atelier-private-tryon and validate strict Magic Bytes
    raw_bytes = await minio.get_object_bytes(key=object_key)
    if not raw_bytes:
        raise TryOnApiError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="INVALID_MAGIC_BYTES",
            message="Uploaded portrait object is missing or empty in atelier-private-tryon.",
        )

    magic_check = validate_magic_bytes(raw_bytes)
    if not magic_check.valid:
        await minio.delete_object(key=object_key)
        now = utcnow()
        async with db.session() as db_sess:
            row = await db_sess.get(TempUserImage, body.temp_image_id)
            if row is not None:
                row.is_purged = True
                row.purged_at = now
                await db_sess.commit()
        raise TryOnApiError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="INVALID_MAGIC_BYTES",
            message=magic_check.error or "Invalid or spoofed image file rejected and deleted.",
        )

    cache_hash = compute_session_cache_hash(
        sha256_hash=body.sha256_hash.strip().lower(),
        mode=body.mode,
        upper_product_id=body.upper_product_id,
        upper_variant_id=body.upper_variant_id,
        lower_product_id=body.lower_product_id,
        lower_variant_id=body.lower_variant_id,
        one_piece_product_id=body.one_piece_product_id,
        one_piece_variant_id=body.one_piece_variant_id,
    )

    total_steps = 2 if body.mode == "MIX_MATCH_OUTFIT" else 1
    now = utcnow()

    # Check Redis SHA-256 Content-Hash Cache (< 1s, 0đ, ZERO quota deduction!)
    if not body.simulate_failure:
        cached = await cache_quota.get_cached(cache_hash)
        cached_object_key = (
            str(cached.get("resultObjectKey"))
            if isinstance(cached, dict) and cached.get("resultObjectKey")
            else None
        )
        if cached_object_key and await minio.head_object(key=cached_object_key):
            quota_snap = await cache_quota.get_dual_quota(
                user_id=user_id,
                ip_address=client_ip,
                loyalty_tier=loyalty_tier,
            )
            session_id = str(uuid4())
            expires_at = now + timedelta(minutes=settings.tryon_purge_ttl_minutes)
            result_url = await minio.generate_presigned_get_url(
                key=cached_object_key,
                expires_in=settings.tryon_presign_get_ttl_seconds,
            )
            elapsed_ms = max(1, int((time.perf_counter() - started) * 1000))

            cached_badge = (
                str(cached.get("providerDisplayBadge"))
                if isinstance(cached, dict) and cached.get("providerDisplayBadge")
                else get_provider_display_badge(
                    str(cached.get("providerUsed"))
                    if isinstance(cached, dict) and cached.get("providerUsed")
                    else "CACHE_HIT"
                )
            )

            async with db.session() as db_sess:
                db_sess.add(
                    TryOnSession(
                        id=session_id,
                        user_id=user_id,
                        guest_session_id=guest_session_id,
                        temp_image_id=body.temp_image_id,
                        mode=body.mode,
                        upper_product_id=body.upper_product_id,
                        lower_product_id=body.lower_product_id,
                        one_piece_product_id=body.one_piece_product_id,
                        provider_used="CACHE_HIT",
                        provider_display_badge=cached_badge,
                        status="COMPLETED",
                        progress_pct=100,
                        step_order=total_steps,
                        total_steps=total_steps,
                        step_message="Kết quả tức thì từ bộ nhớ đệm SHA-256 (không trừ lượt)",
                        total_duration_ms=elapsed_ms,
                        error_code=None,
                        error_message=None,
                        created_at=now,
                        completed_at=now,
                    )
                )
                await db_sess.flush()
                db_sess.add(
                    TryOnResult(
                        id=str(uuid4()),
                        session_id=session_id,
                        result_object_key=cached_object_key,
                        is_purged=False,
                        satisfaction_rating=None,
                        expires_at=expires_at,
                        created_at=now,
                    )
                )
                for pid in dict.fromkeys(
                    p
                    for p in (
                        body.upper_product_id,
                        body.lower_product_id,
                        body.one_piece_product_id,
                    )
                    if p
                ):
                    db_sess.add(
                        TryOnDemandEvent(
                            id=str(uuid4()),
                            product_id=pid,
                            sku_id=None,
                            session_id=session_id,
                            user_id=user_id,
                            signal_type="TRYON_COMPLETED",
                            created_at=now,
                        )
                    )
                await db_sess.commit()

            return build_api_response(
                {
                    "sessionId": session_id,
                    "status": "COMPLETED",
                    "providerUsed": "CACHE_HIT",
                    "providerDisplayBadge": cached_badge,
                    "errorCode": None,
                    "totalSteps": total_steps,
                    "cacheHit": True,
                    "resultUrl": result_url,
                    "expiresAt": expires_at.isoformat(),
                    "remainingQuota": quota_snap.remaining_quota,
                    "durationMs": elapsed_ms,
                },
                request=request,
                status_code=status.HTTP_200_OK,
            )

    # Cache Miss -> Atomically deduct 1 quota unit on Redis (user + IP)
    quota_snap = await cache_quota.deduct_dual_quota(
        user_id=user_id,
        ip_address=client_ip,
        loyalty_tier=loyalty_tier,
    )
    if not quota_snap.allowed:
        raise TryOnApiError(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code="QUOTA_EXCEEDED",
            message="Daily AI Try-On quota exhausted.",
            details={
                "reason": quota_snap.reason,
                "remainingQuota": quota_snap.remaining_quota,
                "dailyLimit": quota_snap.daily_limit,
                "ipRemaining": quota_snap.ip_remaining,
            },
        )

    session_id = str(uuid4())
    session_expires_at = now + timedelta(minutes=settings.tryon_purge_ttl_minutes)
    initial_badge = get_provider_display_badge(provider.provider_type)

    async with db.session() as db_sess:
        db_sess.add(
            TryOnSession(
                id=session_id,
                user_id=user_id,
                guest_session_id=guest_session_id,
                temp_image_id=body.temp_image_id,
                mode=body.mode,
                upper_product_id=body.upper_product_id,
                lower_product_id=body.lower_product_id,
                one_piece_product_id=body.one_piece_product_id,
                provider_used=provider.provider_type,
                provider_display_badge=initial_badge,
                status="QUEUED",
                progress_pct=0,
                step_order=0,
                total_steps=total_steps,
                step_message="Đang xếp hàng xử lý phòng thử AI...",
                total_duration_ms=None,
                error_code=None,
                error_message=None,
                created_at=now,
                completed_at=None,
            )
        )
        await db_sess.flush()

        if body.mode == "MIX_MATCH_OUTFIT":
            db_sess.add(
                TryOnJob(
                    id=str(uuid4()),
                    session_id=session_id,
                    step_order=1,
                    product_id=body.upper_product_id
                    or body.one_piece_product_id
                    or "garment-upper",
                    garment_category="UPPER",
                    cache_hash=cache_hash,
                    status="QUEUED",
                    estimated_cost_usd=0.0,
                    created_at=now,
                )
            )
            db_sess.add(
                TryOnJob(
                    id=str(uuid4()),
                    session_id=session_id,
                    step_order=2,
                    product_id=body.lower_product_id or "garment-lower",
                    garment_category="LOWER",
                    cache_hash=cache_hash,
                    status="QUEUED",
                    estimated_cost_usd=0.0,
                    created_at=now,
                )
            )
        else:
            if body.one_piece_product_id:
                single_cat = "OVERALL"
                single_pid = body.one_piece_product_id
            elif body.lower_product_id and not body.upper_product_id:
                single_cat = "LOWER"
                single_pid = body.lower_product_id
            else:
                single_cat = "UPPER"
                single_pid = body.upper_product_id or "garment-upper"
            db_sess.add(
                TryOnJob(
                    id=str(uuid4()),
                    session_id=session_id,
                    step_order=1,
                    product_id=single_pid,
                    garment_category=single_cat,
                    cache_hash=cache_hash,
                    status="QUEUED",
                    estimated_cost_usd=0.0,
                    created_at=now,
                )
            )
        await db_sess.commit()

    pose_landmarks_payload = (
        body.pose_landmarks.model_dump(by_alias=True, exclude_none=True)
        if body.pose_landmarks is not None
        else None
    )

    await worker.enqueue(
        TryOnQueuedTask(
            session_id=session_id,
            temp_image_id=body.temp_image_id,
            object_key=object_key,
            cache_hash=cache_hash,
            mode=body.mode,
            upper_product_id=body.upper_product_id,
            upper_variant_id=body.upper_variant_id,
            lower_product_id=body.lower_product_id,
            lower_variant_id=body.lower_variant_id,
            one_piece_product_id=body.one_piece_product_id,
            one_piece_variant_id=body.one_piece_variant_id,
            user_id=user_id,
            guest_session_id=guest_session_id,
            ip_address=client_ip,
            loyalty_tier=loyalty_tier,
            correlation_id=correlation_id,
            traceparent=getattr(request.state, "traceparent", ""),
            simulate_failure=bool(body.simulate_failure),
            pose_landmarks=pose_landmarks_payload,
        )
    )

    return build_api_response(
        {
            "sessionId": session_id,
            "status": "QUEUED",
            "providerUsed": provider.provider_type,
            "providerDisplayBadge": initial_badge,
            "errorCode": None,
            "totalSteps": total_steps,
            "cacheHit": False,
            "resultUrl": None,
            "expiresAt": session_expires_at.isoformat(),
            "remainingQuota": quota_snap.remaining_quota,
        },
        request=request,
        status_code=status.HTTP_202_ACCEPTED,
    )


# =============================================================================
# 3. HTTP Polling Fallback (`GET /v1/tryon/sessions/{session_id}`)
# =============================================================================


@v1_router.get("/sessions/{session_id}")
async def get_session_status(
    session_id: str,
    request: Request,
) -> JSONResponse:
    settings, db, minio, cache_quota, _, _, _ = _get_services(request)
    user_id, guest_session_id, client_ip, loyalty_tier, _ = extract_caller_context(request)
    is_privileged = is_privileged_tryon_caller(request, settings)

    async with db.session() as db_sess:
        sess_row = await db_sess.get(TryOnSession, session_id)
        if sess_row is None:
            raise TryOnApiError(
                status_code=status.HTTP_404_NOT_FOUND,
                code="NOT_FOUND",
                message=f"Try-on session '{session_id}' not found.",
            )

        # Strict Phase 6 IDOR protection: enforce owner match unless internal/admin caller
        if not is_privileged:
            if sess_row.user_id:
                if not user_id or user_id != sess_row.user_id:
                    raise TryOnApiError(
                        status_code=status.HTTP_403_FORBIDDEN,
                        code="FORBIDDEN",
                        message="Access denied: you do not have permission to view this try-on session.",
                    )
            elif sess_row.guest_session_id:
                if not guest_session_id or guest_session_id != sess_row.guest_session_id:
                    raise TryOnApiError(
                        status_code=status.HTTP_403_FORBIDDEN,
                        code="FORBIDDEN",
                        message="Access denied: guest session mismatch for this try-on session.",
                    )

        temp_img = await db_sess.get(TempUserImage, sess_row.temp_image_id)
        result_row = (
            await db_sess.execute(
                select(TryOnResult).where(TryOnResult.session_id == session_id)
            )
        ).scalar_one_or_none()

    is_purged = bool(
        (result_row is not None and result_row.is_purged)
        or (temp_img is not None and temp_img.is_purged)
    )

    result_url: str | None = None
    expires_at_iso: str | None = None
    purge_at_iso: str | None = None

    if result_row is not None:
        expires_at_iso = result_row.expires_at.isoformat()
        purge_at_iso = result_row.expires_at.isoformat()
        if sess_row.status == "COMPLETED" and not result_row.is_purged:
            result_url = await minio.generate_presigned_get_url(
                key=result_row.result_object_key,
                expires_in=settings.tryon_presign_get_ttl_seconds,
            )
    elif temp_img is not None:
        expires_at_iso = temp_img.expires_at.isoformat()
        purge_at_iso = temp_img.expires_at.isoformat()

    quota_snap = await cache_quota.get_dual_quota(
        user_id=user_id or sess_row.user_id,
        ip_address=client_ip,
        loyalty_tier=loyalty_tier,
    )

    return build_api_response(
        {
            "sessionId": sess_row.id,
            "status": sess_row.status,
            "mode": sess_row.mode,
            "providerUsed": sess_row.provider_used,
            "providerDisplayBadge": (
                sess_row.provider_display_badge
                or get_provider_display_badge(sess_row.provider_used)
            ),
            "progressPct": sess_row.progress_pct,
            "stepOrder": sess_row.step_order,
            "totalSteps": sess_row.total_steps,
            "stepMessage": (
                "Ảnh đã được tự động xóa khỏi hệ thống sau 15 phút bảo mật."
                if is_purged
                else sess_row.step_message
            ),
            "resultUrl": result_url,
            "errorCode": sess_row.error_code,
            "errorMessage": sess_row.error_message,
            "expiresAt": expires_at_iso,
            "purgeAt": purge_at_iso,
            "totalDurationMs": sess_row.total_duration_ms,
            "remainingQuota": quota_snap.remaining_quota,
            "isPurged": is_purged,
            "is_purged": is_purged,
            "createdAt": sess_row.created_at.isoformat(),
            "completedAt": (
                sess_row.completed_at.isoformat() if sess_row.completed_at else None
            ),
        },
        request=request,
    )


# =============================================================================
# 4. Bookmarks (Saved Try-On Looks, MAX 3 active per owner_key)
# =============================================================================


@v1_router.get("/bookmarks")
async def list_bookmarks(request: Request) -> JSONResponse:
    settings, db, minio, _, _, _, _ = _get_services(request)
    user_id, guest_session_id, _, _, owner_key = extract_caller_context(request)

    async with db.session() as db_sess:
        rows = (
            await db_sess.execute(
                select(SavedTryOnLook, TryOnResult)
                .outerjoin(TryOnResult, TryOnResult.session_id == SavedTryOnLook.session_id)
                .where(SavedTryOnLook.owner_key == owner_key)
                .order_by(desc(SavedTryOnLook.created_at))
            )
        ).all()

    items: list[dict[str, Any]] = []
    for look, result_row in rows:
        if result_row is not None and result_row.is_purged:
            continue
        signed_url = await minio.generate_presigned_get_url(
            key=look.result_object_key,
            expires_in=settings.tryon_presign_get_ttl_seconds,
        )
        items.append(
            {
                "id": look.id,
                "sessionId": look.session_id,
                "userId": user_id,
                "guestSessionId": guest_session_id,
                "upperSkuId": look.upper_sku_id,
                "lowerSkuId": look.lower_sku_id,
                "onePieceSkuId": look.one_piece_sku_id,
                "label": look.label,
                "resultUrl": signed_url,
                "expiresAt": (
                    result_row.expires_at.isoformat() if result_row is not None else None
                ),
                "createdAt": look.created_at.isoformat(),
            }
        )

    return build_api_response(items, request=request)


@v1_router.post("/bookmarks")
async def create_bookmark(
    request: Request,
    body: CreateBookmarkRequestBody,
) -> JSONResponse:
    settings, db, minio, _, _, _, _ = _get_services(request)
    user_id, guest_session_id, _, _, owner_key = extract_caller_context(request)

    async with db.session() as db_sess:
        sess_row = await db_sess.get(TryOnSession, body.session_id)
        if sess_row is None:
            raise TryOnApiError(
                status_code=status.HTTP_404_NOT_FOUND,
                code="NOT_FOUND",
                message=f"Try-on session '{body.session_id}' not found.",
            )
        result_row = (
            await db_sess.execute(
                select(TryOnResult).where(TryOnResult.session_id == body.session_id)
            )
        ).scalar_one_or_none()
        if result_row is None or result_row.is_purged:
            raise TryOnApiError(
                status_code=status.HTTP_400_BAD_REQUEST,
                code="VALIDATION_ERROR",
                message="Try-on session has no active non-purged result to bookmark.",
            )

        active_count = (
            await db_sess.execute(
                select(func.count(SavedTryOnLook.id))
                .outerjoin(TryOnResult, TryOnResult.session_id == SavedTryOnLook.session_id)
                .where(
                    SavedTryOnLook.owner_key == owner_key,
                    (TryOnResult.is_purged.is_(False)) | (TryOnResult.id.is_(None)),
                )
            )
        ).scalar_one()

        if int(active_count) >= settings.tryon_max_bookmarks:
            raise TryOnApiError(
                status_code=status.HTTP_409_CONFLICT,
                code="BOOKMARK_LIMIT_EXCEEDED",
                message=(
                    f"Maximum of {settings.tryon_max_bookmarks} active saved try-on looks "
                    "reached. Delete an existing bookmark before saving a new one."
                ),
                details={
                    "maxBookmarks": settings.tryon_max_bookmarks,
                    "activeCount": int(active_count),
                },
            )

        now = utcnow()
        look = SavedTryOnLook(
            id=str(uuid4()),
            owner_key=owner_key,
            session_id=body.session_id,
            upper_sku_id=body.upper_sku_id,
            lower_sku_id=body.lower_sku_id,
            one_piece_sku_id=body.one_piece_sku_id,
            result_object_key=result_row.result_object_key,
            label=body.label.strip() if body.label else None,
            created_at=now,
        )
        db_sess.add(look)
        await db_sess.commit()

    signed_url = await minio.generate_presigned_get_url(
        key=look.result_object_key,
        expires_in=settings.tryon_presign_get_ttl_seconds,
    )

    return build_api_response(
        {
            "id": look.id,
            "sessionId": look.session_id,
            "userId": user_id,
            "guestSessionId": guest_session_id,
            "upperSkuId": look.upper_sku_id,
            "lowerSkuId": look.lower_sku_id,
            "onePieceSkuId": look.one_piece_sku_id,
            "label": look.label,
            "resultUrl": signed_url,
            "expiresAt": result_row.expires_at.isoformat(),
            "createdAt": look.created_at.isoformat(),
        },
        request=request,
        status_code=status.HTTP_201_CREATED,
    )


@v1_router.delete("/bookmarks/{bookmark_id}")
async def delete_bookmark(
    bookmark_id: str,
    request: Request,
) -> JSONResponse:
    _, db, _, _, _, _, _ = _get_services(request)
    _, _, _, _, owner_key = extract_caller_context(request)

    async with db.session() as db_sess:
        look = await db_sess.get(SavedTryOnLook, bookmark_id)
        if look is None or look.owner_key != owner_key:
            raise TryOnApiError(
                status_code=status.HTTP_404_NOT_FOUND,
                code="NOT_FOUND",
                message=f"Saved try-on bookmark '{bookmark_id}' not found.",
            )
        await db_sess.delete(look)
        await db_sess.commit()

    return build_api_response(
        {"deleted": True, "id": bookmark_id},
        request=request,
    )


# =============================================================================
# 5. Try-On Demand & Conversion Signals + Phase 5 Demand Summary & Lookbook Studio
# =============================================================================


@v1_router.get("/virtual-models")
async def list_virtual_models(request: Request) -> JSONResponse:
    """List the 5 curated editorial virtual studio models for AI Lookbook Studio."""
    models = LookbookStudioService.list_virtual_models()
    return build_api_response(
        {"total": len(models), "models": models},
        request=request,
    )


@v1_router.post("/lookbook-generate")
async def generate_lookbook(
    request: Request,
    body: LookbookGenerateRequestBody,
) -> JSONResponse:
    """Generate a 960x1280 editorial Lookbook WebP on a curated virtual model and upload to atelier-public."""
    code = body.virtual_model_code.strip()
    if code not in VIRTUAL_STUDIO_MODELS_BY_CODE:
        raise TryOnApiError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="VALIDATION_ERROR",
            message=(
                f"Invalid virtualModelCode '{code}'. Allowed values: "
                f"{', '.join(VIRTUAL_STUDIO_MODELS_BY_CODE.keys())}."
            ),
            details={"allowedModels": list(VIRTUAL_STUDIO_MODELS_BY_CODE.keys())},
        )

    studio: LookbookStudioService = request.app.state.lookbook_studio
    result = await studio.generate_lookbook(
        product_id=body.product_id.strip(),
        variant_id=body.variant_id.strip() if body.variant_id else None,
        garment_image_url=body.garment_image_url,
        virtual_model_code=code,
        scene_prompt=body.scene_prompt.strip(),
        product_name=body.product_name,
    )
    return build_api_response(
        result.as_dict(),
        request=request,
        status_code=status.HTTP_201_CREATED,
    )


@v1_router.post("/seasons/{season_slug}/restyle")
async def restyle_season_lookbook(
    season_slug: str,
    request: Request,
    body: SeasonRestyleRequestBody,
) -> JSONResponse:
    """Photometric CIE-LAB + specular sheen recoloring of a seasonal lookbook scene (< 400ms, 0₫)."""
    started = time.perf_counter()
    settings, _, minio, _, _, _, _ = _get_services(request)
    normalized_slug = season_slug.strip().lower()

    if not normalized_slug or not _SAFE_SEASON_SLUG_RE.match(normalized_slug):
        raise TryOnApiError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="VALIDATION_ERROR",
            message=f"Invalid season_slug '{season_slug}'.",
        )

    sorted_selections = sorted(
        body.selections,
        key=lambda sel: (sel.slot_key, sel.product_id),
    )

    if body.combo_key and body.combo_key.strip():
        combo_key = body.combo_key.strip()
    else:
        combo_key = "|".join(
            f"{sel.slot_key}:{(sel.color_key.strip().lower() if sel.color_key and sel.color_key.strip() else f'{sel.variant_id.strip()}:{sel.color_hex.strip().lstrip(chr(35)).lower()}')}"
            for sel in sorted_selections
        )

    if body.hash and _SHA256_HEX_RE.match(body.hash.strip().lower()):
        restyle_hash = body.hash.strip().lower()
    else:
        restyle_hash = hashlib.sha256(
            f"{normalized_slug}|{combo_key}".encode("utf-8")
        ).hexdigest()

    try:
        webp_bytes = await asyncio.to_thread(
            _render_season_restyle_sync,
            season_slug=normalized_slug,
            selections=sorted_selections,
        )
    except FileNotFoundError as exc:
        raise TryOnApiError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="NOT_FOUND",
            message=str(exc),
        ) from exc
    except Exception as exc:
        raise TryOnApiError(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            code="INTERNAL_ERROR",
            message=f"Seasonal photometric restyle failed: {exc}",
        ) from exc

    object_key = f"season-restyle/{restyle_hash}.webp"
    public_bucket = minio.public_bucket
    await minio.ensure_buckets()
    await minio.put_object_bytes(
        bucket=public_bucket,
        key=object_key,
        data=webp_bytes,
        content_type="image/webp",
    )

    public_base = (settings.minio_public_url or minio.endpoint_url).rstrip("/")
    scene_image_url = f"{public_base}/{public_bucket}/{object_key}"
    latency_ms = max(1, int((time.perf_counter() - started) * 1000))

    return build_api_response(
        {
            "status": "COMPLETED",
            "seasonSlug": normalized_slug,
            "comboKey": combo_key,
            "sceneImageUrl": scene_image_url,
            "latencyMs": latency_ms,
        },
        request=request,
        status_code=status.HTTP_200_OK,
    )


@v1_router.post("/signals")
async def create_demand_signal(
    request: Request,
    body: CreateSignalRequestBody,
) -> JSONResponse:
    _, db, _, _, _, _, _ = _get_services(request)
    user_id, _, _, _, _ = extract_caller_context(request)
    resolved_signal = body.signal_type or body.event_type
    if not resolved_signal:
        raise TryOnApiError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="VALIDATION_ERROR",
            message="signalType (or eventType) is required.",
        )

    now = utcnow()
    event_row = TryOnDemandEvent(
        id=str(uuid4()),
        product_id=body.product_id,
        sku_id=body.sku_id,
        sku_code=body.sku_code,
        size_code=body.size_code,
        session_id=body.session_id,
        user_id=user_id,
        signal_type=resolved_signal,
        created_at=now,
    )
    async with db.session() as db_sess:
        db_sess.add(event_row)
        await db_sess.commit()

    return build_api_response(
        {
            "id": event_row.id,
            "productId": event_row.product_id,
            "skuId": event_row.sku_id,
            "skuCode": event_row.sku_code,
            "sizeCode": event_row.size_code,
            "sessionId": event_row.session_id,
            "userId": event_row.user_id,
            "signalType": event_row.signal_type,
            "eventType": event_row.signal_type,
            "createdAt": event_row.created_at.isoformat(),
        },
        request=request,
        status_code=status.HTTP_201_CREATED,
    )


@v1_router.get("/signals")
async def list_demand_signals(
    request: Request,
    product_id: str | None = Query(default=None, alias="productId"),
    signal_type: str | None = Query(default=None, alias="signalType"),
    limit: int = Query(default=100, ge=1, le=500),
) -> JSONResponse:
    _, db, _, _, _, _, _ = _get_services(request)
    stmt = select(TryOnDemandEvent).order_by(desc(TryOnDemandEvent.created_at)).limit(limit)
    if product_id:
        stmt = stmt.where(TryOnDemandEvent.product_id == product_id)
    if signal_type:
        stmt = stmt.where(TryOnDemandEvent.signal_type == signal_type)

    async with db.session() as db_sess:
        rows = (await db_sess.execute(stmt)).scalars().all()

    items = [
        {
            "id": r.id,
            "productId": r.product_id,
            "skuId": r.sku_id,
            "skuCode": r.sku_code,
            "sizeCode": r.size_code,
            "sessionId": r.session_id,
            "userId": r.user_id,
            "signalType": r.signal_type,
            "eventType": r.signal_type,
            "createdAt": r.created_at.isoformat(),
        }
        for r in rows
    ]
    return build_api_response(
        {"items": items, "total": len(items)},
        request=request,
    )


@v1_router.get("/demand-summary")
async def get_demand_summary(
    request: Request,
    period_days: int = Query(default=14, alias="periodDays", ge=1, le=365),
    limit: int = Query(default=10, ge=1, le=100),
) -> JSONResponse:
    """Aggregate tryon_demand_events over `periodDays` per (productId, skuId, skuCode, size)."""
    _, db, _, _, _, _, _ = _get_services(request)
    cutoff = utcnow() - timedelta(days=period_days)

    async with db.session() as db_sess:
        rows = (
            await db_sess.execute(
                select(TryOnDemandEvent).where(
                    TryOnDemandEvent.created_at >= cutoff,
                    TryOnDemandEvent.signal_type.in_(
                        ["TRYON_COMPLETED", "ADD_TO_CART_AFTER_TRYON", "PURCHASE_AFTER_TRYON"]
                    ),
                )
            )
        ).scalars().all()

    grouped: dict[tuple[str, str | None, str | None, str | None], dict[str, Any]] = {}
    for row in rows:
        key = (row.product_id, row.sku_id, row.sku_code, row.size_code)
        entry = grouped.get(key)
        if entry is None:
            entry = {
                "productId": row.product_id,
                "skuId": row.sku_id,
                "skuCode": row.sku_code,
                "size": row.size_code,
                "tryOnSessions": 0,
                "addToCartCount": 0,
                "purchaseCount": 0,
            }
            grouped[key] = entry

        if row.signal_type == "TRYON_COMPLETED":
            entry["tryOnSessions"] += 1
        elif row.signal_type == "ADD_TO_CART_AFTER_TRYON":
            entry["addToCartCount"] += 1
        elif row.signal_type == "PURCHASE_AFTER_TRYON":
            entry["purchaseCount"] += 1

    summary_items: list[dict[str, Any]] = []
    for entry in grouped.values():
        sessions = int(entry["tryOnSessions"])
        atc = int(entry["addToCartCount"])
        rate_pct = round((atc / sessions) * 100.0, 2) if sessions > 0 else 0.0
        summary_items.append(
            {
                **entry,
                "tryOnToCartRatePct": rate_pct,
            }
        )

    summary_items.sort(
        key=lambda item: (item["tryOnSessions"], item["addToCartCount"]),
        reverse=True,
    )
    top_items = summary_items[:limit]

    return build_api_response(
        {
            "periodDays": period_days,
            "totalGroups": len(summary_items),
            "items": top_items,
        },
        request=request,
    )


@v1_router.get("/ops/metrics")
async def get_tryon_ops_metrics(request: Request) -> JSONResponse:
    """Admin AI Ops Funnel telemetry aggregated from isolated `tryon_db`."""
    _, db, _, _, _, _, _ = _get_services(request)

    async with db.session() as db_sess:
        total_sessions = int(
            (await db_sess.execute(select(func.count(TryOnSession.id)))).scalar_one()
        )
        completed_sessions = int(
            (
                await db_sess.execute(
                    select(func.count(TryOnSession.id)).where(
                        TryOnSession.status == "COMPLETED"
                    )
                )
            ).scalar_one()
        )
        failed_sessions = int(
            (
                await db_sess.execute(
                    select(func.count(TryOnSession.id)).where(
                        TryOnSession.status == "FAILED"
                    )
                )
            ).scalar_one()
        )
        mock_count = int(
            (
                await db_sess.execute(
                    select(func.count(TryOnSession.id)).where(
                        TryOnSession.provider_used == "MOCK"
                    )
                )
            ).scalar_one()
        )
        fal_count = int(
            (
                await db_sess.execute(
                    select(func.count(TryOnSession.id)).where(
                        TryOnSession.provider_used == "FAL_CATVTON"
                    )
                )
            ).scalar_one()
        )
        hf_gradio_count = int(
            (
                await db_sess.execute(
                    select(func.count(TryOnSession.id)).where(
                        TryOnSession.provider_used == "HF_GRADIO_VTON"
                    )
                )
            ).scalar_one()
        )
        smart_pose_warp_count = int(
            (
                await db_sess.execute(
                    select(func.count(TryOnSession.id)).where(
                        TryOnSession.provider_used == "SMART_POSE_WARP"
                    )
                )
            ).scalar_one()
        )
        cache_hit_count = int(
            (
                await db_sess.execute(
                    select(func.count(TryOnSession.id)).where(
                        TryOnSession.provider_used == "CACHE_HIT"
                    )
                )
            ).scalar_one()
        )
        estimated_api_cost = float(
            (
                await db_sess.execute(
                    select(func.coalesce(func.sum(TryOnJob.estimated_cost_usd), 0.0))
                )
            ).scalar_one()
            or 0.0
        )
        add_to_cart_after_tryon = int(
            (
                await db_sess.execute(
                    select(func.count(TryOnDemandEvent.id)).where(
                        TryOnDemandEvent.signal_type == "ADD_TO_CART_AFTER_TRYON"
                    )
                )
            ).scalar_one()
        )
        demand_events_count = int(
            (await db_sess.execute(select(func.count(TryOnDemandEvent.id)))).scalar_one()
        )
        active_unpurged_images = int(
            (
                await db_sess.execute(
                    select(func.count(TempUserImage.id)).where(
                        TempUserImage.is_purged.is_(False)
                    )
                )
            ).scalar_one()
        )

    cache_hit_rate_pct = (
        round((cache_hit_count / total_sessions) * 100.0, 2) if total_sessions > 0 else 0.0
    )
    estimated_savings_usd = round(cache_hit_count * 0.03, 4)

    return build_api_response(
        {
            "totalSessions": total_sessions,
            "completedSessions": completed_sessions,
            "failedSessions": failed_sessions,
            "mockCount": mock_count,
            "falCount": fal_count,
            "hfGradioCount": hf_gradio_count,
            "smartPoseWarpCount": smart_pose_warp_count,
            "cacheHitCount": cache_hit_count,
            "cacheHitRatePct": cache_hit_rate_pct,
            "estimatedSavingsUsd": estimated_savings_usd,
            "estimatedApiCostUsd": round(estimated_api_cost, 4),
            "addToCartAfterTryonCount": add_to_cart_after_tryon,
            "demandEventsCount": demand_events_count,
            "activeUnpurgedImagesCount": active_unpurged_images,
        },
        request=request,
    )


# =============================================================================
# 6. Internal Auto-Purge & Dev/Test Expiry Helpers
# =============================================================================


@internal_router.post("/run-purge")
async def run_auto_purge_now(request: Request) -> JSONResponse:
    _, _, _, _, _, _, auto_purge = _get_services(request)
    report = await auto_purge.run_once()
    return build_api_response(report.as_dict(), request=request)


@internal_router.post("/test-expire-session")
async def test_expire_session(
    request: Request,
    body: TestExpireSessionBody | None = None,
) -> JSONResponse:
    settings, _, _, _, _, _, auto_purge = _get_services(request)
    if settings.app_env.strip().lower() == "production":
        raise TryOnApiError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="FORBIDDEN",
            message="test-expire-session is disabled in production.",
        )
    res = await auto_purge.expire_session_for_test(
        session_id=body.session_id if body else None,
        temp_image_id=body.temp_image_id if body else None,
    )
    return build_api_response(res, request=request)
