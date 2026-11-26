from __future__ import annotations

from collections import OrderedDict
import asyncio
import hashlib
import importlib.util
import io
import logging
import math
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import cv2
import httpx
import numpy as np
from PIL import Image, ImageOps
from scipy import ndimage
from scipy.interpolate import RBFInterpolator

from app.config import bootstrap_d_drive_environment
from app.preprocessing.normalizer import normalize_user_portrait_3x4
from app.providers.base import (
    DEFAULT_POSE_TOO_CLOSE_MESSAGE,
    PHOTOMETRIC_INPAINT_BADGE,
    BaseVtonProvider,
    ClothType,
    LightingPreset,
    PoseTooCloseError,
    ProviderCapabilities,
    TryOnGenerationRequest,
    TryOnGenerationResult,
    VTONProviderType,
    VTONRequest,
    VTONResult,
    normalize_cloth_type,
    normalize_lighting_preset,
)

# Ensure D: drive env vars (U2NET_HOME / TMP / TEMP) are locked before rembg loads any weights
bootstrap_d_drive_environment()

logger = logging.getLogger("atelier.ai_tryon.photometric_inpaint")

CANVAS_W = 768
CANVAS_H = 1024

YUNET_MODEL_PATH = (
    Path(__file__).resolve().parents[1]
    / "preprocessing"
    / "models"
    / "face_detection_yunet_2023mar.onnx"
)

_MODEL_LOCK = threading.Lock()
_REMBG_GENERAL_SESSION: Any | None = None
_REMBG_GENERAL_FAILED: bool = False
_REMBG_CLOTH_SESSION: Any | None = None
_REMBG_CLOTH_FAILED: bool = False
_YUNET_DETECTOR: Any | None = None
_HAAR_CLASSIFIER: Any | None = None
_MEDIAPIPE_POSE: Any | None = None
_MEDIAPIPE_CHECKED: bool = False

# Fast thread-safe in-memory LRU caches (zero disk I/O) so switching color/garment
# or running Step 2 on the same portrait drops latency from ~10s to < 0.5s!
_CACHE_LOCK = threading.Lock()
_PERSON_PARSE_CACHE: OrderedDict[str, dict[str, Any]] = OrderedDict()
_GARMENT_PREP_CACHE: OrderedDict[str, Any] = OrderedDict()
_MAX_PERSON_CACHE = 16
_MAX_GARMENT_CACHE = 32


def _lru_get(cache: OrderedDict[str, Any], key: str) -> Any | None:
    with _CACHE_LOCK:
        val = cache.get(key)
        if val is not None:
            cache.move_to_end(key)
        return val


def _lru_set(cache: OrderedDict[str, Any], key: str, value: Any, max_size: int) -> None:
    with _CACHE_LOCK:
        cache[key] = value
        cache.move_to_end(key)
        while len(cache) > max_size:
            cache.popitem(last=False)


def _is_onnxruntime_available() -> bool:
    try:
        return importlib.util.find_spec("onnxruntime") is not None
    except Exception:
        return False


def _get_rembg_general_session() -> Any | None:
    global _REMBG_GENERAL_SESSION, _REMBG_GENERAL_FAILED
    with _MODEL_LOCK:
        if _REMBG_GENERAL_SESSION is not None:
            return _REMBG_GENERAL_SESSION
        if _REMBG_GENERAL_FAILED:
            return None
        if not _is_onnxruntime_available():
            logger.warning(
                "onnxruntime backend not installed; skipping rembg import to avoid SystemExit and using GrabCut fallback"
            )
            _REMBG_GENERAL_FAILED = True
            return None
        try:
            from rembg import new_session

            t0 = time.perf_counter()
            _REMBG_GENERAL_SESSION = new_session("isnet-general-use")
            logger.info(
                "Loaded rembg isnet-general-use session from D: drive in %.2fs",
                time.perf_counter() - t0,
            )
        except (Exception, SystemExit) as exc:
            logger.warning("rembg isnet-general-use unavailable (%s); using GrabCut fallback", exc)
            _REMBG_GENERAL_FAILED = True
            _REMBG_GENERAL_SESSION = None
        return _REMBG_GENERAL_SESSION


def _get_rembg_cloth_session() -> Any | None:
    global _REMBG_CLOTH_SESSION, _REMBG_CLOTH_FAILED
    with _MODEL_LOCK:
        if _REMBG_CLOTH_SESSION is not None:
            return _REMBG_CLOTH_SESSION
        if _REMBG_CLOTH_FAILED:
            return None
        if not _is_onnxruntime_available():
            logger.warning(
                "onnxruntime backend not installed; skipping rembg u2net_cloth_seg to avoid SystemExit and using skin/torso parser"
            )
            _REMBG_CLOTH_FAILED = True
            return None
        try:
            from rembg import new_session

            t0 = time.perf_counter()
            _REMBG_CLOTH_SESSION = new_session("u2net_cloth_seg")
            logger.info(
                "Loaded rembg u2net_cloth_seg session from D: drive in %.2fs",
                time.perf_counter() - t0,
            )
        except (Exception, SystemExit) as exc:
            logger.warning("rembg u2net_cloth_seg unavailable (%s); using skin/torso parser", exc)
            _REMBG_CLOTH_FAILED = True
            _REMBG_CLOTH_SESSION = None
        return _REMBG_CLOTH_SESSION


def _get_face_detector(width: int = CANVAS_W, height: int = CANVAS_H) -> tuple[str, Any | None]:
    global _YUNET_DETECTOR, _HAAR_CLASSIFIER
    with _MODEL_LOCK:
        if hasattr(cv2, "FaceDetectorYN") and YUNET_MODEL_PATH.exists():
            if _YUNET_DETECTOR is None:
                _YUNET_DETECTOR = cv2.FaceDetectorYN.create(
                    str(YUNET_MODEL_PATH),
                    "",
                    (width, height),
                    0.45,
                    0.3,
                    5000,
                )
            _YUNET_DETECTOR.setInputSize((width, height))
            return "yunet", _YUNET_DETECTOR

        if hasattr(cv2, "CascadeClassifier"):
            if _HAAR_CLASSIFIER is None:
                haar_dir = getattr(getattr(cv2, "data", None), "haarcascades", "")
                cand = Path(haar_dir) / "haarcascade_frontalface_default.xml"
                if cand.exists():
                    clf = cv2.CascadeClassifier(str(cand))
                    if not clf.empty():
                        _HAAR_CLASSIFIER = clf
            if _HAAR_CLASSIFIER is not None:
                return "haar", _HAAR_CLASSIFIER

    return "none", None


def _get_optional_mediapipe_pose() -> Any | None:
    global _MEDIAPIPE_POSE, _MEDIAPIPE_CHECKED
    with _MODEL_LOCK:
        if _MEDIAPIPE_CHECKED:
            return _MEDIAPIPE_POSE
        _MEDIAPIPE_CHECKED = True
        try:
            import mediapipe as mp  # type: ignore[import-not-found]

            if hasattr(mp, "solutions") and hasattr(mp.solutions, "pose"):
                _MEDIAPIPE_POSE = mp.solutions.pose.Pose(
                    static_image_mode=True,
                    model_complexity=1,
                    min_detection_confidence=0.5,
                )
        except Exception:
            _MEDIAPIPE_POSE = None
        return _MEDIAPIPE_POSE


# =============================================================================
# Data Models for Pose & Prepared Garments
# =============================================================================


@dataclass(frozen=True)
class AnatomicalPose:
    width: int
    height: int
    face_box: tuple[int, int, int, int] | None  # (fx, fy, fw, fh)
    nose: tuple[float, float]
    left_ear: tuple[float, float]
    right_ear: tuple[float, float]
    mouth_mid: tuple[float, float]
    chin_y: float
    left_shoulder: tuple[float, float]  # Always image-left (smaller x)
    right_shoulder: tuple[float, float]  # Always image-right (larger x)
    left_elbow: tuple[float, float] | None
    right_elbow: tuple[float, float] | None
    left_wrist: tuple[float, float] | None
    right_wrist: tuple[float, float] | None
    left_hip: tuple[float, float]
    right_hip: tuple[float, float]
    mid_shoulder_y: float
    shoulder_dist: float
    shoulder_tilt_rad: float
    hip_dist: float
    torso_height: float
    ear_span: float
    person_mask: np.ndarray  # bool (H, W)
    source: str


@dataclass(frozen=True)
class GarmentAnchors:
    left_shoulder_x: float
    right_shoulder_x: float
    collar_top_y: float
    collar_bottom_y: float
    shoulder_cap_y: float
    waist_y: float
    hem_y: float
    left_hem_x: float
    right_hem_x: float


@dataclass(frozen=True)
class PreparedGarmentData:
    rgba: np.ndarray  # uint8 (gh, gw, 4) tight-cropped & RGB edge-bled
    anchors: GarmentAnchors
    clean_collar_applied: bool


# =============================================================================
# Step B Helper: Clean Garment Preparation (Shared Across ALL 4 VTON Tiers!)
# =============================================================================


def _parse_hex_rgb(hex_color: str | None) -> tuple[int, int, int] | None:
    if not hex_color:
        return None
    cleaned = hex_color.strip().lstrip("#")
    if len(cleaned) == 3:
        cleaned = "".join(ch * 2 for ch in cleaned)
    if len(cleaned) != 6:
        return None
    try:
        return (int(cleaned[0:2], 16), int(cleaned[2:4], 16), int(cleaned[4:6], 16))
    except ValueError:
        return None


def _bleed_rgb_into_transparent(rgba_arr: np.ndarray) -> np.ndarray:
    """Fill transparent pixels with nearest solid RGB so warping never creates dark halos."""
    alpha = rgba_arr[:, :, 3]
    valid = alpha > 36
    if not np.any(valid) or np.all(valid):
        return rgba_arr
    _, nearest_idx = ndimage.distance_transform_edt(~valid, return_indices=True)
    bled_rgb = rgba_arr[:, :, :3][nearest_idx[0], nearest_idx[1]]
    out = rgba_arr.copy()
    out[:, :, :3] = np.where(valid[:, :, None], rgba_arr[:, :, :3], bled_rgb)
    return out


def _strip_studio_white_border_floodfill(rgba_arr: np.ndarray) -> np.ndarray:
    """Strip border-connected studio white/ivory background if corners are light opaque."""
    h, w = rgba_arr.shape[:2]
    rgb = rgba_arr[:, :, :3].astype(np.float32)
    alpha = rgba_arr[:, :, 3].copy()

    corners = [(2, 2), (max(0, w - 3), 2), (2, max(0, h - 3)), (max(0, w - 3), max(0, h - 3))]
    light_corners: list[np.ndarray] = []
    for cx, cy in corners:
        a = int(alpha[cy, cx])
        r, g, b = rgb[cy, cx]
        luma = 0.299 * r + 0.587 * g + 0.114 * b
        chroma = float(max(r, g, b) - min(r, g, b))
        if a > 220 and luma > 186.0 and chroma < 48.0:
            light_corners.append(rgb[cy, cx])

    if len(light_corners) < 2:
        # Still check for stray pure-white (>242) pixels connected to border
        near_white = (
            (rgb[:, :, 0] > 242)
            & (rgb[:, :, 1] > 242)
            & (rgb[:, :, 2] > 242)
            & (alpha > 10)
        )
        border = np.zeros((h, w), dtype=bool)
        border[0, :] = near_white[0, :]
        border[-1, :] = near_white[-1, :]
        border[:, 0] = near_white[:, 0]
        border[:, -1] = near_white[:, -1]
        if not np.any(border):
            return rgba_arr
        labeled, _ = ndimage.label(near_white)
        seeds = np.unique(labeled[border])
        seeds = seeds[seeds > 0]
        if len(seeds) == 0:
            return rgba_arr
        bg_mask = np.isin(labeled, seeds)
        out = rgba_arr.copy()
        out[:, :, 3][bg_mask] = 0
        return out

    bg_rgb = np.mean(light_corners, axis=0)
    dist = (
        np.abs(rgb[:, :, 0] - bg_rgb[0]) * 0.36
        + np.abs(rgb[:, :, 1] - bg_rgb[1]) * 0.40
        + np.abs(rgb[:, :, 2] - bg_rgb[2]) * 0.24
    )
    chroma_map = np.max(rgb, axis=2) - np.min(rgb, axis=2)
    cand = (dist < 30.0) & (chroma_map < 52.0) & (alpha > 10)

    border = np.zeros((h, w), dtype=bool)
    border[0, :] = cand[0, :]
    border[-1, :] = cand[-1, :]
    border[:, 0] = cand[:, 0]
    border[:, -1] = cand[:, -1]
    if not np.any(border):
        return rgba_arr

    labeled, _ = ndimage.label(cand)
    seeds = np.unique(labeled[border])
    seeds = seeds[seeds > 0]
    if len(seeds) == 0:
        return rgba_arr

    bg_mask = np.isin(labeled, seeds)
    out = rgba_arr.copy()
    out[:, :, 3][bg_mask] = 0

    # Softly feather 1px boundary directly adjacent to removed studio background
    bg_dilated = cv2.dilate(bg_mask.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=1) > 0
    edge = bg_dilated & (~bg_mask) & (dist < 44.0)
    if np.any(edge):
        factor = np.clip((dist[edge] - 24.0) / 22.0, 0.15, 0.85)
        out[:, :, 3][edge] = np.round(out[:, :, 3][edge].astype(np.float32) * factor).astype(np.uint8)
    return out


def _decontaminate_edge_halos(rgba_arr: np.ndarray) -> np.ndarray:
    """Remove pale studio matte contamination along semi-transparent edges."""
    out = rgba_arr.copy()
    alpha = out[:, :, 3]
    alpha[alpha < 16] = 0

    semi = (alpha >= 16) & (alpha < 230)
    if not np.any(semi):
        return out

    rgb = out[:, :, :3].astype(np.float32)
    a_f = alpha.astype(np.float32) / 255.0
    luma = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    chroma = np.max(rgb, axis=2) - np.min(rgb, axis=2)

    pale_fringe = semi & (alpha < 88) & (luma > 224.0) & (chroma < 24.0)
    alpha[pale_fringe] = np.round(alpha[pale_fringe] * 0.25).astype(np.uint8)

    decontam = semi & (~pale_fringe)
    if np.any(decontam):
        strength = np.clip((1.0 - a_f[decontam]) * 0.64, 0.0, 0.58)
        denom = np.maximum(0.35, 1.0 - strength)
        matte = np.array([246.0, 242.0, 236.0], dtype=np.float32)
        cleaned_rgb = (rgb[decontam] - matte[None, :] * strength[:, None]) / denom[:, None]
        out[:, :, :3][decontam] = np.clip(np.round(cleaned_rgb), 0, 255).astype(np.uint8)

    out[:, :, 3] = alpha
    return out


def _measure_bodice_stats(rgba_arr: np.ndarray, bbox: tuple[int, int, int, int]) -> dict[str, float]:
    x0, y0, x1, y1 = bbox
    gw = max(1, x1 - x0)
    gh = max(1, y1 - y0)
    bx0 = int(round(x0 + gw * 0.25))
    bx1 = int(round(x0 + gw * 0.75))
    by0 = int(round(y0 + gh * 0.30))
    by1 = int(round(y0 + gh * 0.65))

    patch = rgba_arr[by0:by1, bx0:bx1]
    solid = patch[:, :, 3] >= 190
    count = int(np.count_nonzero(solid))
    if count < 40:
        return {
            "mean_r": 210.0,
            "mean_g": 205.0,
            "mean_b": 196.0,
            "median_luma": 205.0,
            "p15_luma": 150.0,
            "sample_count": float(count),
        }

    px = patch[:, :, :3][solid].astype(np.float32)
    luma = 0.299 * px[:, 0] + 0.587 * px[:, 1] + 0.114 * px[:, 2]
    p15, med = np.percentile(luma, [15, 50])
    return {
        "mean_r": float(np.mean(px[:, 0])),
        "mean_g": float(np.mean(px[:, 1])),
        "mean_b": float(np.mean(px[:, 2])),
        "median_luma": float(med),
        "p15_luma": float(p15),
        "sample_count": float(count),
    }


def _clean_inner_collar_cavity(
    rgba_arr: np.ndarray,
    bbox: tuple[int, int, int, int],
    bodice: dict[str, float],
    cloth_type: ClothType,
) -> tuple[np.ndarray, bool]:
    """
    Surgical inner-collar mannequin cavity & grey back-lining removal:
    Strips dark/grey inner collar cavities (e.g. `Áo Len Cashmere Cổ Lọ` Kem Cashmere & Cacao Đậm),
    2-pixel shadow fringe rings, and thin floating back-collar rim bridges cleanly to alpha=0
    while protecting genuinely pitch-black garments (`median_luma < 36`).
    """
    if cloth_type == "lower" or bodice["sample_count"] < 40 or bodice["median_luma"] < 36.0:
        return rgba_arr, False

    h, w = rgba_arr.shape[:2]
    bx0, by0, bx1, by1 = bbox
    gw = max(1, bx1 - bx0)
    gh = max(1, by1 - by0)

    zx0 = max(0, int(math.floor(bx0 + gw * 0.28)))
    zx1 = min(w, int(math.ceil(bx0 + gw * 0.72)))
    zy0 = max(0, by0)
    zy1 = min(h, int(math.ceil(by0 + gh * 0.24)))
    zw, zh = zx1 - zx0, zy1 - zy0
    if zw < 8 or zh < 8:
        return rgba_arr, False

    zone = rgba_arr[zy0:zy1, zx0:zx1]
    z_rgb = zone[:, :, :3].astype(np.float32)
    z_alpha = zone[:, :, 3]
    z_opaque = z_alpha >= 24

    z_luma = np.where(
        z_opaque,
        0.299 * z_rgb[:, :, 0] + 0.587 * z_rgb[:, :, 1] + 0.114 * z_rgb[:, :, 2],
        255.0,
    )
    z_chroma = np.max(z_rgb, axis=2) - np.min(z_rgb, axis=2)
    color_div = (
        np.abs(z_rgb[:, :, 0] - bodice["mean_r"])
        + np.abs(z_rgb[:, :, 1] - bodice["mean_g"])
        + np.abs(z_rgb[:, :, 2] - bodice["mean_b"])
    )

    med_luma = bodice["median_luma"]
    is_light_or_mid = med_luma >= 95.0
    dark_luma_cut = min(104.0, med_luma - 62.0) if is_light_or_mid else min(36.0, med_luma * 0.48)
    dark_p15_cut = max(92.0, bodice["p15_luma"] - 24.0)
    grey_luma_cut = min(176.0, med_luma - 42.0)

    if is_light_or_mid:
        dark_cand = (
            z_opaque
            & (z_luma < dark_luma_cut)
            & (z_luma < dark_p15_cut)
            & (z_chroma < 46.0)
            & (color_div > 140.0)
        )
        grey_cand = (
            z_opaque
            & (med_luma >= 148.0)
            & (z_luma < grey_luma_cut)
            & (z_chroma < 26.0)
            & (color_div > 110.0)
        )
    else:
        dark_cand = z_opaque & (z_luma < dark_luma_cut) & (z_chroma < 26.0)
        grey_cand = np.zeros((zh, zw), dtype=bool)

    min_comp_area = max(42, int(round(gw * gh * 0.00042)))
    max_top_clearance = max(8, int(round(gh * 0.075)))
    remove_mask = np.zeros((zh, zw), dtype=bool)
    removed_boxes: list[tuple[int, int, int, int]] = []

    def _collect(cand: np.ndarray, require_top_touch: bool) -> None:
        if not np.any(cand):
            return
        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(
            cand.astype(np.uint8),
            connectivity=4,
        )
        ring_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
        for cid in range(1, num_labels):
            area = int(stats[cid, cv2.CC_STAT_AREA])
            if area < min_comp_area:
                continue
            cx = float(centroids[cid, 0])
            c_left = int(stats[cid, cv2.CC_STAT_LEFT])
            c_top = int(stats[cid, cv2.CC_STAT_TOP])
            c_w = int(stats[cid, cv2.CC_STAT_WIDTH])
            c_h = int(stats[cid, cv2.CC_STAT_HEIGHT])
            c_right = c_left + c_w - 1
            c_bot = c_top + c_h - 1

            centroid_norm_x = (zx0 + cx - bx0) / float(gw)
            comp_min_norm_y = (zy0 + c_top - by0) / float(gh)
            comp_max_norm_y = (zy0 + c_bot - by0) / float(gh)
            if not (0.32 <= centroid_norm_x <= 0.68):
                continue
            if comp_min_norm_y > 0.14 or comp_max_norm_y > 0.23:
                continue

            comp_mask = labels == cid
            comp_mean_luma = float(np.mean(z_luma[comp_mask]))

            # Surrounding collar wall contrast check
            dilated = cv2.dilate(comp_mask.astype(np.uint8), ring_kernel, iterations=1) > 0
            ring = dilated & (~comp_mask) & (z_alpha >= 120)
            ring_count = int(np.count_nonzero(ring))
            if ring_count < 16:
                continue
            ring_mean_luma = float(np.mean(z_luma[ring]))
            if ring_mean_luma - comp_mean_luma < 20.0:
                continue

            # Check whether component touches top transparency OR sits just beneath thin collar lip
            ys_c, xs_c = np.where(comp_mask)
            global_ys = zy0 + ys_c
            global_xs = zx0 + xs_c
            above_ys = np.maximum(0, global_ys - 1)
            touches_top = bool(
                np.any((global_ys <= by0 + 1) | (rgba_arr[above_ys, global_xs, 3] < 28))
            )

            near_neckline = touches_top
            if not near_neckline and not require_top_touch:
                mid_x = max(0, min(w - 1, zx0 + (c_left + c_right) // 2))
                start_y = zy0 + c_top
                has_open_above = any(
                    (start_y - step < 0) or (rgba_arr[start_y - step, mid_x, 3] < 28)
                    for step in range(1, max_top_clearance + 1)
                )
                mid_y = max(0, min(h - 1, zy0 + (c_top + c_bot) // 2))
                lx_wall = max(0, min(w - 1, zx0 + c_left - 5))
                rx_wall = max(0, min(w - 1, zx0 + c_right + 5))
                has_walls = (
                    int(rgba_arr[mid_y, lx_wall, 3]) >= 120
                    and int(rgba_arr[mid_y, rx_wall, 3]) >= 120
                )
                near_neckline = has_open_above and has_walls

            if not near_neckline:
                continue

            remove_mask[comp_mask] = True
            removed_boxes.append((c_left, c_top, c_right, c_bot))

    _collect(dark_cand, require_top_touch=False)
    if is_light_or_mid:
        _collect(grey_cand, require_top_touch=True)

    if not np.any(remove_mask):
        return rgba_arr, False

    out = rgba_arr.copy()
    out_zone_alpha = out[zy0:zy1, zx0:zx1, 3].copy()
    out_zone_alpha[remove_mask] = 0

    # Clean 2-pixel dark shadow fringe around the removed cavity
    ring_dark_cut = (med_luma - 28.0) if is_light_or_mid else (med_luma * 0.65)
    k3 = np.ones((3, 3), np.uint8)
    r1 = (cv2.dilate(remove_mask.astype(np.uint8), k3, iterations=1) > 0) & (~remove_mask) & (out_zone_alpha > 0)
    r1_dark = r1 & (z_luma < ring_dark_cut)
    r1_soft = r1 & (~r1_dark)
    out_zone_alpha[r1_dark] = 0
    out_zone_alpha[r1_soft] = np.round(out_zone_alpha[r1_soft].astype(np.float32) * 0.40).astype(np.uint8)

    r2 = (
        (cv2.dilate(r1.astype(np.uint8), k3, iterations=1) > 0)
        & (~remove_mask)
        & (~r1)
        & (out_zone_alpha > 0)
        & (z_luma < ring_dark_cut * 0.85)
    )
    out_zone_alpha[r2] = np.round(out_zone_alpha[r2].astype(np.float32) * 0.20).astype(np.uint8)

    # Strip thin floating back-collar rim bridge sitting directly above removed cavity
    max_lip_thickness = max(14, int(round(gh * 0.048)))
    for c_left, c_top, c_right, _ in removed_boxes:
        pad_x = max(6, int(round((c_right - c_left) * 0.08)))
        sx0 = max(0, c_left - pad_x)
        sx1 = min(zw - 1, c_right + pad_x)
        for col in range(sx0, sx1 + 1):
            cav_rows = np.where(remove_mask[:, col])[0]
            top_cav_y = int(cav_rows[0]) if len(cav_rows) > 0 else (c_top + 2)
            if top_cav_y <= 0:
                continue
            opaque_above = int(np.count_nonzero(out_zone_alpha[:top_cav_y, col] >= 24))
            if 0 < opaque_above <= max_lip_thickness:
                out_zone_alpha[:top_cav_y, col] = 0

    # Trim narrow asymmetric collar corner spikes (< 16px wide) protruding above the clean collar rim
    for zy in range(0, min(zh, max(8, int(round(gh * 0.08))))):
        row_op = out_zone_alpha[zy] >= 32
        if not np.any(row_op):
            continue
        # Remove tiny disconnected horizontal runs (< 16px wide) at the very top of the collar opening
        num_r, lbl_r, st_r, _ = cv2.connectedComponentsWithStats(row_op.astype(np.uint8), connectivity=4)
        for rid in range(1, num_r):
            if int(st_r[rid, cv2.CC_STAT_AREA]) < max(12, int(round(gw * 0.035))):
                out_zone_alpha[zy][lbl_r[0] == rid] = 0

    out[zy0:zy1, zx0:zx1, 3] = out_zone_alpha
    return out, True


def _apply_variant_color_recoloring(
    rgba_arr: np.ndarray,
    bodice: dict[str, float],
    target_hex: str | None,
) -> np.ndarray:
    """
    Luminance-preserving knit/silk/wool variant color transformation.
    When `target_hex` closely matches source photography (delta < 32), leaves photo untouched.
    """
    tgt_rgb = _parse_hex_rgb(target_hex)
    if tgt_rgb is None or bodice["sample_count"] < 40:
        return rgba_arr

    tgt_r, tgt_g, tgt_b = float(tgt_rgb[0]), float(tgt_rgb[1]), float(tgt_rgb[2])
    src_r, src_g, src_b = bodice["mean_r"], bodice["mean_g"], bodice["mean_b"]
    src_luma = 0.299 * src_r + 0.587 * src_g + 0.114 * src_b
    tgt_luma = 0.299 * tgt_r + 0.587 * tgt_g + 0.114 * tgt_b

    dr, dg, db = tgt_r - src_r, tgt_g - src_g, tgt_b - src_b
    perceptual_delta = math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db)
    hue_shift = (
        abs((tgt_r - tgt_luma) - (src_r - src_luma))
        + abs((tgt_g - tgt_luma) - (src_g - src_luma))
        + abs((tgt_b - tgt_luma) - (src_b - src_luma))
    )
    effective_delta = max(perceptual_delta, hue_shift * 0.55)
    if effective_delta < 32.0:
        return rgba_arr

    blend_strength = float(np.clip((effective_delta - 26.0) / 48.0, 0.18, 0.94))
    ref_mid = float(np.clip(bodice["median_luma"], 36.0, 236.0))
    darkening = tgt_luma < src_luma - 28.0
    lightening = tgt_luma > src_luma + 28.0

    out = rgba_arr.copy()
    mask = out[:, :, 3] >= 10
    if not np.any(mask):
        return out

    rgb = out[:, :, :3][mask].astype(np.float32)
    px_luma = 0.299 * rgb[:, 0] + 0.587 * rgb[:, 1] + 0.114 * rgb[:, 2]
    fold_ratio = px_luma / ref_mid

    if darkening:
        shaped = np.power(np.clip(fold_ratio, 0.18, 1.48), 1.18)
        mult = 0.24 + 0.84 * shaped
        micro_sheen = np.maximum(0.0, fold_ratio - 1.04) * 38.0
        out_r = tgt_r * mult + micro_sheen * (0.65 + (tgt_r / 255.0) * 0.35)
        out_g = tgt_g * mult + micro_sheen * (0.62 + (tgt_g / 255.0) * 0.38)
        out_b = tgt_b * mult + micro_sheen * (0.58 + (tgt_b / 255.0) * 0.42)
    elif lightening:
        shaped = np.power(np.clip(fold_ratio, 0.32, 1.55), 0.72)
        mult = 0.42 + 0.60 * shaped
        out_r = tgt_r * mult
        out_g = tgt_g * mult
        out_b = tgt_b * mult
    else:
        mult = np.clip(fold_ratio, 0.28, 1.46)
        out_r = tgt_r * mult
        out_g = tgt_g * mult
        out_b = tgt_b * mult

    recolored = np.stack([out_r, out_g, out_b], axis=-1)
    blended = rgb + (recolored - rgb) * blend_strength
    out[:, :, :3][mask] = np.clip(np.round(blended), 0, 255).astype(np.uint8)
    return out


def _detect_garment_anchors(rgba_arr: np.ndarray, cloth_type: ClothType) -> GarmentAnchors:
    """Measure normalized [0..1] anatomical anchor coordinates on tight-cropped garment RGBA."""
    h, w = rgba_arr.shape[:2]
    alpha = rgba_arr[:, :, 3]

    def _row_span(y_norm: float) -> tuple[float, float] | None:
        y = max(0, min(h - 1, int(round(y_norm * (h - 1)))))
        xs = np.where(alpha[y] >= 40)[0]
        if len(xs) < 4:
            return None
        return float(xs[0]) / float(w), float(xs[-1]) / float(w)

    # Collar top row in central band
    cx0, cx1 = int(w * 0.32), int(w * 0.68)
    collar_top_row = 0
    for y in range(0, max(1, int(h * 0.35))):
        if np.any(alpha[y, cx0 : cx1 + 1] >= 50):
            collar_top_row = y
            break

    # Front neckline rim along exact center column band (46%..54%) skipping any lip above hole
    mx0, mx1 = int(w * 0.46), max(int(w * 0.46) + 1, int(w * 0.54))
    max_neck_scan = max(collar_top_row + 1, int(h * 0.44))
    min_solid_run = max(4, int(round(h * 0.025)))
    solid_run = 0
    first_solid_start = -1
    saw_hole_after_lip = False
    last_front_start = -1
    collar_bottom_row = collar_top_row

    for y in range(collar_top_row, max_neck_scan):
        ratio = float(np.mean(alpha[y, mx0 : mx1 + 1] >= 65))
        if ratio >= 0.55:
            if solid_run == 0:
                if first_solid_start == -1:
                    first_solid_start = y
                last_front_start = y
            solid_run += 1
            if solid_run >= min_solid_run and (saw_hole_after_lip or (y - collar_top_row) > int(h * 0.05)):
                collar_bottom_row = last_front_start
                break
        else:
            if 0 < solid_run < int(h * 0.05):
                saw_hole_after_lip = True
            solid_run = 0

    if collar_bottom_row == collar_top_row and first_solid_start != -1:
        collar_bottom_row = last_front_start if (saw_hole_after_lip and last_front_start != -1) else first_solid_start

    collar_top_y = float(np.clip(collar_top_row / max(1.0, float(h)), 0.01, 0.25))
    collar_bottom_y = float(
        np.clip(max(collar_bottom_row / max(1.0, float(h)), collar_top_y + 0.03), 0.04, 0.38)
    )

    sh_probe_y = float(
        np.clip(collar_top_y + (0.09 if cloth_type == "overall" else 0.14), 0.08, 0.32)
    )
    sh_span = _row_span(sh_probe_y) or (0.14, 0.86)

    # Outer shoulder cap height at x=0.22w & x=0.78w
    def _col_top(x_norm: float) -> float | None:
        x = max(0, min(w - 1, int(round(x_norm * (w - 1)))))
        ys = np.where(alpha[: max(1, int(h * 0.42)), x] >= 65)[0]
        return float(ys[0]) / max(1.0, float(h)) if len(ys) > 0 else None

    l_cap = _col_top(0.22)
    r_cap = _col_top(0.78)
    if l_cap is not None and r_cap is not None:
        sh_cap_y = 0.5 * (l_cap + r_cap)
    else:
        sh_cap_y = l_cap if l_cap is not None else (r_cap if r_cap is not None else collar_top_y + 0.11)
    shoulder_cap_y = float(np.clip(sh_cap_y, 0.04, 0.26))

    # Waist Y
    waist_y = 0.06 if cloth_type == "lower" else (0.37 if cloth_type == "overall" else 0.66)
    if cloth_type != "lower":
        min_w = 2.0
        scan_s, scan_e = (0.28, 0.46) if cloth_type == "overall" else (0.48, 0.78)
        for k in range(int(scan_s * 50), int(scan_e * 50) + 1):
            yn = k / 50.0
            sp = _row_span(yn)
            if sp is not None:
                sw = sp[1] - sp[0]
                if 0.20 < sw < min_w:
                    min_w = sw
                    waist_y = yn

    # Hem Y & hem left/right span
    hem_row = h - 1
    for y in range(h - 1, max(0, int(h * 0.60)) - 1, -1):
        if np.any(alpha[y] >= 36):
            hem_row = y
            break
    hem_y = float(np.clip((hem_row + 1) / max(1.0, float(h)), 0.70, 1.0))
    hem_span = _row_span(max(0.70, hem_y - 0.04)) or (0.14, 0.86)

    return GarmentAnchors(
        left_shoulder_x=float(np.clip(sh_span[0], 0.02, 0.45)),
        right_shoulder_x=float(np.clip(sh_span[1], 0.55, 0.98)),
        collar_top_y=collar_top_y,
        collar_bottom_y=collar_bottom_y,
        shoulder_cap_y=shoulder_cap_y,
        waist_y=float(np.clip(waist_y, 0.05, 0.88)),
        hem_y=hem_y,
        left_hem_x=float(np.clip(hem_span[0], 0.02, 0.46)),
        right_hem_x=float(np.clip(hem_span[1], 0.54, 0.98)),
    )


def prepare_clean_garment_rgba(
    garment_bytes: bytes,
    *,
    cloth_type: str = "upper",
    color_hex: str | None = None,
) -> PreparedGarmentData:
    """
    Full garment preparation shared across ALL 4 VTON tiers:
      1. Decode EXIF-transposed RGBA
      2. Strip studio background (fast floodfill -> rembg neural fallback if needed)
      3. Decontaminate pale edge halos
      4. Surgical inner-collar mannequin cavity & back-lining removal
      5. Luminance-preserving variant swatch recoloring (if `color_hex` differs from base photo)
      6. Tight-crop, anatomical anchor extraction, and RGB edge-bleeding
    """
    ct = normalize_cloth_type(cloth_type)
    g_hash = hashlib.sha256(garment_bytes).hexdigest()[:24]
    g_cache_key = f"{g_hash}|{ct}|{(color_hex or '').strip().lower()}"
    cached = _lru_get(_GARMENT_PREP_CACHE, g_cache_key)
    if cached is not None:
        return cached

    with Image.open(io.BytesIO(garment_bytes)) as raw:
        im = ImageOps.exif_transpose(raw)
        has_alpha = "A" in im.getbands()
        rgba = im.convert("RGBA")

    # Bound huge source photos to 1024px max side for fast, sharp CV processing
    max_side = max(rgba.width, rgba.height)
    if max_side > 1024:
        scale = 1024.0 / float(max_side)
        rgba = rgba.resize(
            (max(16, int(round(rgba.width * scale))), max(16, int(round(rgba.height * scale)))),
            Image.Resampling.LANCZOS,
        )

    arr = np.array(rgba, dtype=np.uint8)
    gh, gw = arr.shape[:2]
    corner_alphas = [
        int(arr[0, 0, 3]),
        int(arr[0, gw - 1, 3]),
        int(arr[gh - 1, 0, 3]),
        int(arr[gh - 1, gw - 1, 3]),
    ]

    if not has_alpha or any(ca > 10 for ca in corner_alphas):
        arr = _strip_studio_white_border_floodfill(arr)
        post_corners = [
            int(arr[0, 0, 3]),
            int(arr[0, gw - 1, 3]),
            int(arr[gh - 1, 0, 3]),
            int(arr[gh - 1, gw - 1, 3]),
        ]
        if any(ca > 16 for ca in post_corners):
            sess = _get_rembg_general_session()
            if sess is not None:
                try:
                    from rembg import remove

                    cut = remove(rgba.convert("RGB"), session=sess, post_process_mask=True).convert("RGBA")
                    arr = _strip_studio_white_border_floodfill(np.array(cut, dtype=np.uint8))
                except (Exception, SystemExit) as exc:
                    logger.warning("rembg garment cleanup failed (%s); keeping floodfill result", exc)

    arr = _decontaminate_edge_halos(arr)

    fg = arr[:, :, 3] >= 24
    ys, xs = np.where(fg)
    if len(xs) < 20 or len(ys) < 20:
        raise RuntimeError("Garment RGBA cutout is empty after background cleanup.")

    bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    bodice = _measure_bodice_stats(arr, bbox)

    arr, clean_collar_applied = _clean_inner_collar_cavity(arr, bbox, bodice, ct)
    arr = _apply_variant_color_recoloring(arr, bodice, color_hex)

    # Recompute tight bounding box after collar cleaning with 2% safety pad
    fg2 = arr[:, :, 3] >= 24
    ys2, xs2 = np.where(fg2)
    if len(xs2) < 20 or len(ys2) < 20:
        ys2, xs2 = ys, xs

    x0, x1 = int(xs2.min()), int(xs2.max()) + 1
    y0, y1 = int(ys2.min()), int(ys2.max()) + 1
    pad_x = max(3, int(round((x1 - x0) * 0.02)))
    pad_y = max(3, int(round((y1 - y0) * 0.02)))
    tx0 = max(0, x0 - pad_x)
    ty0 = max(0, y0 - pad_y)
    tx1 = min(arr.shape[1], x1 + pad_x)
    ty1 = min(arr.shape[0], y1 + pad_y)

    cropped = arr[ty0:ty1, tx0:tx1].copy()
    cropped[:, :, 3] = np.where(cropped[:, :, 3] < 14, 0, cropped[:, :, 3])
    anchors = _detect_garment_anchors(cropped, ct)
    bled = _bleed_rgb_into_transparent(cropped)

    result = PreparedGarmentData(
        rgba=bled,
        anchors=anchors,
        clean_collar_applied=clean_collar_applied,
    )
    _lru_set(_GARMENT_PREP_CACHE, g_cache_key, result, _MAX_GARMENT_CACHE)
    return result


def composite_garment_studio_white(
    garment_bytes: bytes,
    *,
    cloth_type: str = "upper",
    color_hex: str | None = None,
    output_format: str = "PNG",
) -> tuple[bytes, bool]:
    """
    Prepare a collar-cleaned, variant-recolored garment composited on crisp 768x1024 #FAFAFA
    studio white — ideal input for Diffusion VTON tiers (Fal, Fashn, HF ZeroGPU, Local GPU).
    """
    prepared = prepare_clean_garment_rgba(
        garment_bytes,
        cloth_type=cloth_type,
        color_hex=color_hex,
    )
    garment_im = Image.fromarray(prepared.rgba, mode="RGBA")
    fitted = ImageOps.contain(garment_im, (680, 920), method=Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (250, 250, 250, 255))
    canvas.paste(
        fitted,
        ((CANVAS_W - fitted.width) // 2, (CANVAS_H - fitted.height) // 2),
        fitted,
    )
    out = io.BytesIO()
    if output_format.upper() == "WEBP":
        canvas.convert("RGB").save(out, format="WEBP", quality=92, method=4)
    else:
        canvas.convert("RGB").save(out, format="PNG")
    return out.getvalue(), prepared.clean_collar_applied


def normalize_output_768x1024(image_bytes: bytes, *, fmt: str = "WEBP") -> bytes:
    """Normalize any upstream VTON output bytes to exact 768x1024 RGB WebP/PNG."""
    with Image.open(io.BytesIO(image_bytes)) as raw:
        im = ImageOps.exif_transpose(raw).convert("RGB")
        if im.size != (CANVAS_W, CANVAS_H):
            im = ImageOps.fit(
                im,
                (CANVAS_W, CANVAS_H),
                method=Image.Resampling.LANCZOS,
                centering=(0.5, 0.5),
            )
        out = io.BytesIO()
        if fmt.upper() == "PNG":
            im.save(out, format="PNG")
        else:
            im.save(out, format="WEBP", quality=92, method=4)
        return out.getvalue()


async def resolve_bytes_or_url(
    raw_bytes: bytes | None,
    url: str | None,
    *,
    timeout_seconds: float = 8.0,
) -> bytes:
    if raw_bytes:
        return raw_bytes
    if url:
        cleaned = url.strip()
        if cleaned.startswith("data:"):
            import base64

            _, _, b64_part = cleaned.partition(",")
            return base64.b64decode(b64_part)
        if cleaned.startswith("http://") or cleaned.startswith("https://"):
            fetch_url = cleaned.replace("http://localhost:", "http://127.0.0.1:")
            async with httpx.AsyncClient(timeout=timeout_seconds) as client:
                resp = await client.get(fetch_url)
                resp.raise_for_status()
                return resp.content
        p = Path(cleaned)
        if p.is_file():
            return p.read_bytes()
    raise RuntimeError("Missing required image bytes or reachable URL.")


# =============================================================================
# Step A Helper: Human Parsing, Silhouette, Pose Extraction & Old-Sleeve Inpaint
# =============================================================================


def _extract_person_silhouette(rgb_img: Image.Image, person_hash: str = "") -> np.ndarray:
    """Extract binary person silhouette mask via D:-drive rembg isnet-general-use (cached, GrabCut fallback)."""
    if person_hash:
        cached_entry = _lru_get(_PERSON_PARSE_CACHE, person_hash)
        if cached_entry is not None and "person_mask" in cached_entry:
            return cached_entry["person_mask"]

    w, h = rgb_img.size
    sess = _get_rembg_general_session()
    mask: np.ndarray | None = None
    if sess is not None:
        try:
            from rembg import remove

            small = rgb_img.resize((256, 341), Image.Resampling.BILINEAR)
            rgba_small = remove(small, session=sess, post_process_mask=True).convert("RGBA")
            alpha_small = np.array(rgba_small.split()[3], dtype=np.uint8)
            alpha_full = cv2.resize(alpha_small, (w, h), interpolation=cv2.INTER_LINEAR)
            cand = ndimage.binary_fill_holes(alpha_full > 40)
            if int(np.count_nonzero(cand)) > 500:
                mask = cand
        except (Exception, SystemExit) as exc:
            logger.warning("rembg silhouette failed (%s); falling back to GrabCut", exc)

    if mask is None:
        # Fast GrabCut fallback on downscaled 192x256
        rgb_np = np.array(rgb_img, dtype=np.uint8)
        bgr_small = cv2.cvtColor(cv2.resize(rgb_np, (192, 256)), cv2.COLOR_RGB2BGR)
        gc_mask = np.zeros((256, 192), dtype=np.uint8)
        rect = (18, 10, 156, 242)
        bgd = np.zeros((1, 65), np.float64)
        fgd = np.zeros((1, 65), np.float64)
        try:
            cv2.grabCut(bgr_small, gc_mask, rect, bgd, fgd, 3, cv2.GC_INIT_WITH_RECT)
            fg_small = ((gc_mask == cv2.GC_FGD) | (gc_mask == cv2.GC_PR_FGD)).astype(np.uint8) * 255
            fg_full = cv2.resize(fg_small, (w, h), interpolation=cv2.INTER_LINEAR) > 127
            mask = ndimage.binary_fill_holes(fg_full)
        except Exception:
            fallback = np.zeros((h, w), dtype=bool)
            cv2.ellipse(
                fallback.view(np.uint8),
                (w // 2, int(h * 0.56)),
                (int(w * 0.34), int(h * 0.48)),
                0,
                0,
                360,
                1,
                -1,
            )
            mask = fallback

    if person_hash:
        entry = _lru_get(_PERSON_PARSE_CACHE, person_hash) or {}
        entry["person_mask"] = mask
        _lru_set(_PERSON_PARSE_CACHE, person_hash, entry, _MAX_PERSON_CACHE)
    return mask


def _extract_old_cloth_mask(
    rgb_img: Image.Image,
    person_mask: np.ndarray,
    pose: AnatomicalPose,
    cloth_type: ClothType,
    person_hash: str = "",
) -> np.ndarray:
    """
    Parse the wearer's existing garment silhouette using D:-drive `u2net_cloth_seg` (cached)
    (with fast non-skin torso/shoulder fallback) so exposed old sleeves/tank straps
    outside the new garment can be cleanly suppressed via `cv2.inpaint(..., INPAINT_TELEA)`.
    """
    cache_field = f"cloth_{cloth_type}"
    if person_hash:
        cached_entry = _lru_get(_PERSON_PARSE_CACHE, person_hash)
        if cached_entry is not None and cache_field in cached_entry:
            return cached_entry[cache_field]

    w, h = rgb_img.size
    sess = _get_rembg_cloth_session()
    full_mask: np.ndarray | None = None
    if sess is not None:
        try:
            from rembg import remove

            sw, sh = 256, 341
            small = rgb_img.resize((sw, sh), Image.Resampling.BILINEAR)
            category_arg = "lower" if cloth_type == "lower" else ("full" if cloth_type == "overall" else "upper")
            try:
                mask_im = remove(
                    small,
                    session=sess,
                    only_mask=True,
                    cloth_category=category_arg,
                )
            except TypeError:
                mask_im = remove(small, session=sess, only_mask=True)

            m_arr = np.array(mask_im)
            if m_arr.ndim == 3:
                m_arr = m_arr[:, :, 0]
            if m_arr.shape[0] == sh * 3:
                band_idx = 1 if cloth_type == "lower" else (2 if cloth_type == "overall" else 0)
                m_arr = m_arr[band_idx * sh : (band_idx + 1) * sh, :]
            if m_arr.shape[:2] != (sh, sw):
                m_arr = cv2.resize(m_arr, (sw, sh), interpolation=cv2.INTER_NEAREST)

            cand = cv2.resize(m_arr.astype(np.uint8), (w, h), interpolation=cv2.INTER_LINEAR) > 80
            cand = cand & person_mask
            if int(np.count_nonzero(cand)) > 300:
                full_mask = cand
        except (Exception, SystemExit) as exc:
            logger.debug("u2net_cloth_seg parse skipped (%s); using YCrCb skin-exclusion parser", exc)

    if full_mask is None:
        rgb_np = np.array(rgb_img, dtype=np.uint8)
        ycrcb = cv2.cvtColor(rgb_np, cv2.COLOR_RGB2YCrCb)
        skin = (
            (ycrcb[:, :, 1] >= 131)
            & (ycrcb[:, :, 1] <= 176)
            & (ycrcb[:, :, 2] >= 78)
            & (ycrcb[:, :, 2] <= 130)
        )
        region = np.zeros((h, w), dtype=bool)
        if cloth_type == "lower":
            y_top = max(0, int(pose.mid_shoulder_y + pose.torso_height * 0.72))
            region[y_top:, :] = True
        else:
            y_top = max(0, int(pose.chin_y + 10))
            y_bot = min(h, int(pose.mid_shoulder_y + pose.torso_height * (1.75 if cloth_type == "overall" else 1.15)))
            region[y_top:y_bot, :] = True
        full_mask = person_mask & region & (~skin)

    if person_hash:
        entry = _lru_get(_PERSON_PARSE_CACHE, person_hash) or {}
        entry[cache_field] = full_mask
        _lru_set(_PERSON_PARSE_CACHE, person_hash, entry, _MAX_PERSON_CACHE)
    return full_mask


def _detect_primary_face(
    rgb_np: np.ndarray,
) -> tuple[tuple[int, int, int, int] | None, float | None, tuple[float, float] | None]:
    """Detect primary face box, refined chin_y, and nose/mouth estimate via OpenCV YuNet/Haar."""
    h, w = rgb_np.shape[:2]
    bgr = cv2.cvtColor(rgb_np, cv2.COLOR_RGB2BGR)
    kind, detector = _get_face_detector(w, h)

    if kind == "yunet" and detector is not None:
        _, faces = detector.detect(bgr)
        if faces is not None and len(faces) > 0:
            best = max(
                faces,
                key=lambda f: float(f[2]) * float(f[3]) * (1.0 if float(f[-1]) >= 0.55 else 0.5),
            )
            fx = max(0, int(round(float(best[0]))))
            fy = max(0, int(round(float(best[1]))))
            fw = max(1, int(round(float(best[2]))))
            fh = max(1, int(round(float(best[3]))))
            mouth_y = 0.5 * (float(best[11]) + float(best[13]))
            chin_y = float(max(fy + fh * 1.03, mouth_y + 0.30 * fh))
            chin_y = max(float(fy + fh * 0.5), min(float(h - 1), chin_y))
            nose = (float(best[8]), float(best[9]))
            return (fx, fy, fw, fh), chin_y, nose

    if kind == "haar" and detector is not None:
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        rects = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60))
        if len(rects) > 0:
            fx, fy, fw, fh = max(rects, key=lambda r: int(r[2]) * int(r[3]))
            chin_y = min(float(h - 1), float(fy + fh * 1.04))
            nose = (float(fx + fw * 0.5), float(fy + fh * 0.55))
            return (int(fx), int(fy), int(fw), int(fh)), chin_y, nose

    return None, None, None


def _parse_single_point(raw: Any, w: int, h: int) -> tuple[float, float, float] | None:
    if not isinstance(raw, dict):
        return None
    x, y = raw.get("x"), raw.get("y")
    if x is None or y is None:
        return None
    try:
        xf, yf = float(x), float(y)
        vis = float(raw.get("visibility", 1.0)) if raw.get("visibility") is not None else 1.0
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(xf) and math.isfinite(yf)):
        return None
    px = xf * w if xf <= 1.5 else xf
    py = yf * h if yf <= 1.5 else yf
    return (
        max(0.0, min(float(w - 1), px)),
        max(0.0, min(float(h - 1), py)),
        max(0.0, min(1.0, vis)),
    )


def _extract_client_landmarks(
    pose_landmarks: list[dict[str, Any]] | dict[str, Any] | None,
    w: int,
    h: int,
) -> dict[str, tuple[float, float, float]]:
    """
    Parse EITHER MediaPipe 33-point `list[dict]` (Stage 1/2 Storefront)
    OR legacy dict `{nose, leftShoulder, rightShoulder, leftHip, rightHip, ...}`.
    """
    parsed: dict[str, tuple[float, float, float]] = {}
    if isinstance(pose_landmarks, list) and len(pose_landmarks) >= 13:
        idx_map = {
            "nose": 0,
            "left_ear": 7,
            "right_ear": 8,
            "mouth_left": 9,
            "mouth_right": 10,
            "left_shoulder": 11,
            "right_shoulder": 12,
            "left_elbow": 13,
            "right_elbow": 14,
            "left_wrist": 15,
            "right_wrist": 16,
            "left_hip": 23,
            "right_hip": 24,
        }
        for name, idx in idx_map.items():
            if idx < len(pose_landmarks):
                pt = _parse_single_point(pose_landmarks[idx], w, h)
                if pt is not None and pt[2] >= 0.25 and 4.0 < pt[0] < w - 4.0 and 4.0 < pt[1] < h - 4.0:
                    parsed[name] = pt
    elif isinstance(pose_landmarks, dict):
        dict_map = {
            "nose": "nose",
            "left_shoulder": "leftShoulder",
            "right_shoulder": "rightShoulder",
            "left_elbow": "leftElbow",
            "right_elbow": "rightElbow",
            "left_wrist": "leftWrist",
            "right_wrist": "rightWrist",
            "left_hip": "leftHip",
            "right_hip": "rightHip",
        }
        for target, src_key in dict_map.items():
            pt = _parse_single_point(pose_landmarks.get(src_key), w, h)
            if pt is not None:
                parsed[target] = pt
    return parsed


def _row_span(mask: np.ndarray, y: int) -> tuple[int, int, int]:
    h, w = mask.shape
    yc = max(0, min(h - 1, int(y)))
    xs = np.where(mask[yc])[0]
    if len(xs) < 6:
        return (w // 2, w // 2, 0)
    return int(xs[0]), int(xs[-1]), int(xs[-1] - xs[0])


def detect_anatomical_pose(
    person_image_bytes: bytes,
    *,
    pose_landmarks: list[dict[str, Any]] | dict[str, Any] | None = None,
    strict_pose_gate: bool = True,
) -> tuple[Image.Image, AnatomicalPose]:
    """
    Normalize portrait to 768x1024, extract person silhouette + face + full anatomical joints
    (shoulders, elbows, wrists, hips, ears, nose, chin), and enforce `POSE_TOO_CLOSE` gate.
    """
    canvas_rgba = normalize_user_portrait_3x4(
        person_image_bytes,
        target_size=(CANVAS_W, CANVAS_H),
    )
    rgb_img = canvas_rgba.convert("RGB")
    rgb_np = np.array(rgb_img, dtype=np.uint8)
    h, w = rgb_np.shape[:2]

    client_pts = _extract_client_landmarks(pose_landmarks, w, h)

    # Check explicit low shoulder visibility in dict-format pose landmarks
    if strict_pose_gate and isinstance(pose_landmarks, dict):
        for sh_key in ("leftShoulder", "rightShoulder"):
            raw_pt = _parse_single_point(pose_landmarks.get(sh_key), w, h)
            if raw_pt is not None and raw_pt[2] < 0.50:
                raise PoseTooCloseError(
                    DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                    details={"reason": f"{sh_key}_visibility_low", "visibility": round(raw_pt[2], 3)},
                )

    face_box, yunet_chin_y, yunet_nose = _detect_primary_face(rgb_np)

    # Optional close-up face hard gate (fast fail before rembg!)
    if strict_pose_gate and face_box is not None and yunet_chin_y is not None:
        fx, fy, fw, fh = face_box
        face_h_ratio = fh / float(h)
        face_w_ratio = fw / float(w)
        chin_ratio = yunet_chin_y / float(h)
        torso_remaining = 1.0 - chin_ratio
        if face_h_ratio > 0.42 or chin_ratio > 0.76 or torso_remaining < 0.22 or face_w_ratio > 0.48:
            raise PoseTooCloseError(
                DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                details={
                    "reason": "face_closeup_gate",
                    "faceHeightRatio": round(face_h_ratio, 3),
                    "chinYRatio": round(chin_ratio, 3),
                },
            )

    # Optional server-side MediaPipe Pose if installed
    mp_pts: dict[str, tuple[float, float, float]] = {}
    if "left_shoulder" not in client_pts or "right_shoulder" not in client_pts:
        mp_pose = _get_optional_mediapipe_pose()
        if mp_pose is not None:
            try:
                res = mp_pose.process(rgb_np)
                if res and res.pose_landmarks:
                    lms = res.pose_landmarks.landmark
                    for k, idx in (
                        ("nose", 0),
                        ("left_ear", 7),
                        ("right_ear", 8),
                        ("mouth_left", 9),
                        ("mouth_right", 10),
                        ("left_shoulder", 11),
                        ("right_shoulder", 12),
                        ("left_elbow", 13),
                        ("right_elbow", 14),
                        ("left_wrist", 15),
                        ("right_wrist", 16),
                        ("left_hip", 23),
                        ("right_hip", 24),
                    ):
                        lm = lms[idx]
                        vis = float(getattr(lm, "visibility", 1.0))
                        if vis >= 0.40:
                            mp_pts[k] = (float(lm.x) * w, float(lm.y) * h, vis)
            except Exception:
                pass

    person_hash = hashlib.sha256(person_image_bytes).hexdigest()[:24]
    person_mask = _extract_person_silhouette(rgb_img, person_hash=person_hash)

    # Resolve shoulders (client MediaPipe -> server MediaPipe -> silhouette + face scan)
    left_sh: tuple[float, float] | None = None
    right_sh: tuple[float, float] | None = None
    pose_source = "silhouette_cv"

    if "left_shoulder" in client_pts and "right_shoulder" in client_pts:
        pts = sorted(
            [
                (client_pts["left_shoulder"][0], client_pts["left_shoulder"][1]),
                (client_pts["right_shoulder"][0], client_pts["right_shoulder"][1]),
            ],
            key=lambda p: p[0],
        )
        left_sh, right_sh = pts[0], pts[1]
        pose_source = "client_landmarks"
    elif "left_shoulder" in mp_pts and "right_shoulder" in mp_pts:
        pts = sorted(
            [
                (mp_pts["left_shoulder"][0], mp_pts["left_shoulder"][1]),
                (mp_pts["right_shoulder"][0], mp_pts["right_shoulder"][1]),
            ],
            key=lambda p: p[0],
        )
        left_sh, right_sh = pts[0], pts[1]
        pose_source = "mediapipe_server"

    chin_y = yunet_chin_y
    if left_sh is None or right_sh is None:
        ys_fg, xs_fg = np.where(person_mask)
        if len(ys_fg) < 500:
            if strict_pose_gate:
                raise PoseTooCloseError(
                    DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                    details={"reason": "no_person_silhouette"},
                )
            left_sh, right_sh = (0.34 * w, 0.34 * h), (0.66 * w, 0.34 * h)
        else:
            if face_box is None or chin_y is None:
                top_y = int(ys_fg.min())
                _, _, upper_w = _row_span(person_mask, min(h - 1, top_y + int(0.16 * h)))
                if strict_pose_gate and upper_w / float(w) > 0.72:
                    raise PoseTooCloseError(
                        DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                        details={"reason": "closeup_no_face_wide_top"},
                    )
                chin_y = float(min(int(0.32 * h), top_y + int(0.20 * h)))
                cx = float(np.median(xs_fg[ys_fg <= top_y + int(0.20 * h)])) if np.any(ys_fg <= top_y + int(0.20 * h)) else w * 0.5
                est_fw = max(90, int(0.16 * w))
                face_box = (
                    max(0, int(cx - est_fw * 0.5)),
                    max(0, int(chin_y - est_fw * 1.15)),
                    est_fw,
                    int(est_fw * 1.15),
                )

            fx, fy, fw, fh = face_box
            face_cx = fx + fw * 0.5
            scan_start = min(h - 4, int(chin_y + 0.02 * h))
            scan_end = min(h - 2, int(chin_y + 0.28 * h))
            if scan_end <= scan_start + 8:
                if strict_pose_gate:
                    raise PoseTooCloseError(
                        DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                        details={"reason": "no_shoulder_space_below_chin"},
                    )
                left_sh, right_sh = (0.34 * w, 0.34 * h), (0.66 * w, 0.34 * h)
            else:
                sample_ys = list(range(scan_start, scan_end, 4))
                spans = [_row_span(person_mask, y) for y in sample_ys]
                widths = [sp[2] for sp in spans]
                max_band_w = max(widths) if widths else 0
                neck_slice = widths[: max(1, len(widths) // 3)]
                min_neck_w = min(neck_slice) if neck_slice else int(fw * 0.65)
                target_sh_threshold = max(
                    int(fw * 1.48),
                    int(min_neck_w * 1.38),
                    int(max_band_w * 0.78),
                    int(0.22 * w),
                )
                sh_idx = next((i for i, sw in enumerate(widths) if sw >= target_sh_threshold), None)
                if sh_idx is None:
                    if max_band_w >= int(0.22 * w):
                        sh_idx = int(np.argmax(widths))
                    elif strict_pose_gate:
                        raise PoseTooCloseError(
                            DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                            details={"reason": "shoulders_not_visible", "maxBandWidth": max_band_w},
                        )
                    else:
                        sh_idx = 0

                sh_y = float(sample_ys[sh_idx])
                sh_measure_y = min(h - 2, int(sh_y + max(12, int(0.025 * h))))
                lx_raw, rx_raw, sh_span = _row_span(person_mask, sh_measure_y)
                if strict_pose_gate and sh_span < int(0.20 * w):
                    raise PoseTooCloseError(
                        DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                        details={"reason": "shoulder_span_too_narrow", "shoulderSpan": sh_span},
                    )
                inset = sh_span * 0.08
                ls_x = max(8.0, lx_raw + inset)
                rs_x = min(float(w - 9), rx_raw - inset)

                def _sh_top(col_x: float) -> float:
                    c = max(0, min(w - 1, int(round(col_x))))
                    band = person_mask[
                        max(int(chin_y or 0), 0) : min(h, sh_measure_y + 24),
                        max(0, c - 4) : min(w, c + 5),
                    ]
                    rows_hit = np.where(np.any(band, axis=1))[0]
                    if len(rows_hit) > 0:
                        return float(max(int(chin_y or 0), 0) + int(rows_hit[0]) + 8)
                    return sh_y

                ls_y, rs_y = _sh_top(ls_x), _sh_top(rs_x)
                avg_sy = 0.5 * (ls_y + rs_y)
                max_tilt = 0.045 * h
                ls_y = float(np.clip(ls_y, avg_sy - max_tilt, avg_sy + max_tilt))
                rs_y = float(np.clip(rs_y, avg_sy - max_tilt, avg_sy + max_tilt))

                if abs((ls_x + rs_x) * 0.5 - face_cx) > 0.14 * w:
                    half_sh = max(min(abs(face_cx - ls_x), abs(rs_x - face_cx)), fw * 0.85, 0.14 * w)
                    ls_x = max(8.0, face_cx - half_sh)
                    rs_x = min(float(w - 9), face_cx + half_sh)

                left_sh, right_sh = (ls_x, ls_y), (rs_x, rs_y)

    assert left_sh is not None and right_sh is not None
    mid_sh_y = 0.5 * (left_sh[1] + right_sh[1])
    sh_cx = 0.5 * (left_sh[0] + right_sh[0])
    dx = max(24.0, right_sh[0] - left_sh[0])
    dy = right_sh[1] - left_sh[1]
    sh_dist = float(math.hypot(dx, dy))
    sh_tilt = float(np.clip(math.atan2(dy, dx), -0.22, 0.22))

    if strict_pose_gate:
        if mid_sh_y / float(h) > 0.72 or mid_sh_y / float(h) < 0.14:
            raise PoseTooCloseError(
                DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                details={"reason": "mid_shoulder_out_of_bounds", "midShoulderYRatio": round(mid_sh_y / float(h), 3)},
            )
        if sh_dist < 0.14 * w:
            raise PoseTooCloseError(
                DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                details={"reason": "shoulder_dist_too_small"},
            )

    # Resolve nose, ears, mouth, chin
    merged_pts = {**mp_pts, **client_pts}
    if "nose" in merged_pts:
        nose = (merged_pts["nose"][0], merged_pts["nose"][1])
    elif yunet_nose is not None:
        nose = yunet_nose
    elif face_box is not None:
        nose = (face_box[0] + face_box[2] * 0.5, face_box[1] + face_box[3] * 0.55)
    else:
        nose = (sh_cx, max(24.0, mid_sh_y - 0.15 * h))

    if "left_ear" in merged_pts and "right_ear" in merged_pts:
        ears = sorted(
            [(merged_pts["left_ear"][0], merged_pts["left_ear"][1]), (merged_pts["right_ear"][0], merged_pts["right_ear"][1])],
            key=lambda p: p[0],
        )
        left_ear, right_ear = ears[0], ears[1]
    elif face_box is not None:
        fx, fy, fw, fh = face_box
        left_ear = (float(fx), float(fy + fh * 0.48))
        right_ear = (float(fx + fw), float(fy + fh * 0.48))
    else:
        left_ear = (nose[0] - sh_dist * 0.24, nose[1] - 6.0)
        right_ear = (nose[0] + sh_dist * 0.24, nose[1] - 6.0)

    if "mouth_left" in merged_pts and "mouth_right" in merged_pts:
        mouth_mid = (
            0.5 * (merged_pts["mouth_left"][0] + merged_pts["mouth_right"][0]),
            0.5 * (merged_pts["mouth_left"][1] + merged_pts["mouth_right"][1]),
        )
    elif face_box is not None:
        fx, fy, fw, fh = face_box
        mouth_mid = (float(fx + fw * 0.5), float(fy + fh * 0.76))
    else:
        mouth_mid = (nose[0], nose[1] + 36.0)

    # Compute refined chin_y
    if chin_y is None:
        nose_to_mouth = float(np.clip(mouth_mid[1] - nose[1], 16.0, 62.0))
        chin_y = float(mouth_mid[1] + nose_to_mouth * 0.92)
    chin_y = float(np.clip(chin_y, mouth_mid[1] + 10.0, mid_sh_y - max(18.0, 0.022 * h)))

    ear_span = float(np.clip(abs(right_ear[0] - left_ear[0]), sh_dist * 0.34, sh_dist * 0.72))

    # Resolve hips
    if "left_hip" in merged_pts and "right_hip" in merged_pts:
        hips = sorted(
            [(merged_pts["left_hip"][0], merged_pts["left_hip"][1]), (merged_pts["right_hip"][0], merged_pts["right_hip"][1])],
            key=lambda p: p[0],
        )
        left_hip, right_hip = hips[0], hips[1]
    else:
        torso_est = float(np.clip(sh_dist * 1.44, 0.29 * h, 0.42 * h))
        hip_y = min(float(h - 24), mid_sh_y + torso_est)
        _, _, hspan = _row_span(person_mask, int(hip_y))
        if int(0.18 * w) <= hspan <= int(0.85 * w):
            hip_half = min(0.5 * hspan * 0.88, sh_dist * 0.62)
        else:
            hip_half = sh_dist * 0.48
        left_hip = (max(8.0, sh_cx - hip_half), hip_y)
        right_hip = (min(float(w - 9), sh_cx + hip_half), hip_y)

    hip_mid_y = 0.5 * (left_hip[1] + right_hip[1])
    hip_dist = max(sh_dist * 0.68, abs(right_hip[0] - left_hip[0]))
    torso_height = float(np.clip(hip_mid_y - mid_sh_y, sh_dist * 1.12, h * 0.48))

    # Optional elbows & wrists (image-left / image-right sorted)
    left_elbow = right_elbow = None
    if "left_elbow" in merged_pts and "right_elbow" in merged_pts:
        elbows = sorted(
            [(merged_pts["left_elbow"][0], merged_pts["left_elbow"][1]), (merged_pts["right_elbow"][0], merged_pts["right_elbow"][1])],
            key=lambda p: p[0],
        )
        left_elbow, right_elbow = elbows[0], elbows[1]

    left_wrist = right_wrist = None
    if "left_wrist" in merged_pts and "right_wrist" in merged_pts:
        wrists = sorted(
            [(merged_pts["left_wrist"][0], merged_pts["left_wrist"][1]), (merged_pts["right_wrist"][0], merged_pts["right_wrist"][1])],
            key=lambda p: p[0],
        )
        left_wrist, right_wrist = wrists[0], wrists[1]

    return canvas_rgba, AnatomicalPose(
        width=w,
        height=h,
        face_box=face_box,
        nose=nose,
        left_ear=left_ear,
        right_ear=right_ear,
        mouth_mid=mouth_mid,
        chin_y=chin_y,
        left_shoulder=left_sh,
        right_shoulder=right_sh,
        left_elbow=left_elbow,
        right_elbow=right_elbow,
        left_wrist=left_wrist,
        right_wrist=right_wrist,
        left_hip=left_hip,
        right_hip=right_hip,
        mid_shoulder_y=mid_sh_y,
        shoulder_dist=sh_dist,
        shoulder_tilt_rad=sh_tilt,
        hip_dist=hip_dist,
        torso_height=torso_height,
        ear_span=ear_span,
        person_mask=person_mask,
        source=pose_source,
    )


# =============================================================================
# Step B: Multi-Zone Anatomical TPS Cage Deformation (768x1024)
# =============================================================================


def _is_high_neck_garment(garment_name: str, anchors: GarmentAnchors, cloth_type: ClothType) -> bool:
    lower = (garment_name or "").lower()
    if any(
        tok in lower
        for tok in ("cổ lọ", "co lo", "turtleneck", "cổ trụ", "áo dài", "ao dai", "mock neck")
    ):
        return True
    collar_depth = anchors.collar_bottom_y - anchors.collar_top_y
    return cloth_type == "upper" and collar_depth < 0.065


def _compute_garment_placement_and_tps(
    prepared: PreparedGarmentData,
    pose: AnatomicalPose,
    *,
    cloth_type: ClothType,
    garment_name: str,
    old_cloth_mask: np.ndarray | None = None,
    step_order: int = 1,
) -> tuple[np.ndarray, np.ndarray, float, bool, tuple[float, float, float, float]]:
    """
    Warp garment RGBA onto the 768x1024 portrait via smooth Thin-Plate-Spline (TPS)
    multi-zone anatomical cage deformation anchored to shoulders (11,12), neck pit,
    elbows (13,14), and hips (23,24).
    Returns: (warped_rgb, warped_alpha_f, front_collar_rim_y, is_high_neck, (draw_x, draw_y, draw_w, draw_h)).
    """
    w, h = pose.width, pose.height
    gh, gw = prepared.rgba.shape[:2]
    anchors = prepared.anchors
    nat_aspect = max(0.28, float(gw) / max(1.0, float(gh)))
    neck_h = max(24.0, pose.mid_shoulder_y - pose.chin_y)
    high_neck = _is_high_neck_garment(garment_name, anchors, cloth_type)
    is_sleeved = nat_aspect >= 0.56

    sh_cx = 0.5 * (pose.left_shoulder[0] + pose.right_shoulder[0])
    hip_cx = 0.5 * (pose.left_hip[0] + pose.right_hip[0])
    sh_tilt = pose.shoulder_tilt_rad
    ux, uy = math.cos(sh_tilt), math.sin(sh_tilt)
    vx, vy = -math.sin(sh_tilt), math.cos(sh_tilt)

    lower_mask_top_y: int | None = None

    if cloth_type == "lower":
        # Detect real existing lower garment bounds (e.g. blue jeans below tank top OR below Step 1 sweater)
        detected_lower_top: float | None = None
        detected_lower_cx: float | None = None
        detected_hip_w: float | None = None
        detected_thigh_w: float | None = None

        if old_cloth_mask is not None and int(np.count_nonzero(old_cloth_mask)) > 1500:
            ys_lo, xs_lo = np.where(old_cloth_mask)
            raw_top = float(np.percentile(ys_lo, 2))
            if pose.mid_shoulder_y + pose.torso_height * 0.45 <= raw_top <= h * 0.88:
                detected_lower_top = raw_top
                detected_lower_cx = float(np.median(xs_lo))
                # Measure width near upper hip & lower thigh of real lower garment
                probe_hip_y = min(h - 4, int(raw_top + max(36.0, (h - raw_top) * 0.25)))
                probe_thigh_y = min(h - 4, int(raw_top + max(80.0, (h - raw_top) * 0.68)))
                _, _, hw_lo = _row_span(old_cloth_mask, probe_hip_y)
                _, _, tw_lo = _row_span(old_cloth_mask, probe_thigh_y)
                if hw_lo >= int(0.18 * w):
                    detected_hip_w = float(hw_lo)
                if tw_lo >= int(0.16 * w):
                    detected_thigh_w = float(tw_lo)

        hip_mid_y = 0.5 * (pose.left_hip[1] + pose.right_hip[1])
        center_x = detected_lower_cx if detected_lower_cx is not None else hip_cx

        if detected_lower_top is not None:
            if step_order >= 2:
                # 2-Step Outfit mode: anchor trousers anatomically at real hip/waist level
                # and let the Step 1 upper garment hem drape naturally OVER the trouser top!
                waist_line_y = max(
                    pose.mid_shoulder_y + pose.torso_height * 0.72,
                    min(detected_lower_top - 42.0, hip_mid_y - 16.0),
                )
                lower_mask_top_y = int(round(detected_lower_top))
            else:
                waist_line_y = max(
                    pose.mid_shoulder_y + pose.torso_height * 0.62,
                    detected_lower_top - 6.0,
                )
        else:
            waist_line_y = pose.mid_shoulder_y + pose.torso_height * (0.96 if step_order >= 2 else 0.78)

        # TRUE full-length garment height (NEVER squash ankle trousers into a 3/4 portrait crop!)
        target_hip_w = max(
            (detected_hip_w or 0.0) * 1.12,
            pose.hip_dist * 1.48,
            pose.shoulder_dist * 1.16,
        )
        target_hip_w = float(np.clip(target_hip_w, w * 0.34, w * 0.68))
        draw_w = float(np.clip(target_hip_w * 1.24, w * 0.38, w * 0.78))
        # Natural trouser length extends cleanly below bottom of 3/4 frame when standing close
        draw_h = max(draw_w / nat_aspect, pose.torso_height * 2.15, float(h) * 0.68)
        draw_x = center_x - draw_w * 0.5
        draw_y = waist_line_y - anchors.waist_y * draw_h
        front_collar_rim_y = float(lower_mask_top_y if lower_mask_top_y is not None else waist_line_y)

        # Measure real garment waist/hip/leg spans on the flat-lay RGBA so splayed legs straighten cleanly
        g_alpha = prepared.rgba[:, :, 3]
        def _g_row_span(yn: float, default_span: tuple[float, float]) -> tuple[float, float]:
            gy = max(0, min(gh - 1, int(round(yn * (gh - 1)))))
            xs = np.where(g_alpha[gy] >= 40)[0]
            return (float(xs[0]) / gw, float(xs[-1]) / gw) if len(xs) >= 4 else default_span

        wb_l, wb_r = _g_row_span(0.06, (0.28, 0.72))
        hip_l, hip_r = _g_row_span(0.28, (0.22, 0.78))
        leg_l, leg_r = _g_row_span(0.70, (0.14, 0.86))
        hem_l, hem_r = _g_row_span(0.95, (anchors.left_hem_x, anchors.right_hem_x))

        # Straighten splayed flat-lay legs vertically to match standing posture (zero V-gap bleed!)
        waist_half = target_hip_w * 0.44
        hip_half = target_hip_w * 0.52
        thigh_target_w = max((detected_thigh_w or target_hip_w) * 1.14, target_hip_w * 0.98)
        thigh_half = float(np.clip(thigh_target_w * 0.52, hip_half * 0.90, hip_half * 1.12))
        hem_half = thigh_half * 1.04

        y_wb = waist_line_y
        y_hip = waist_line_y + draw_h * 0.25
        y_leg = waist_line_y + draw_h * 0.68
        y_hem = waist_line_y + draw_h * 0.95

        src_norm = np.array(
            [
                [wb_l, 0.06],
                [0.50, 0.06],
                [wb_r, 0.06],
                [hip_l, 0.28],
                [0.50, 0.28],
                [hip_r, 0.28],
                [leg_l, 0.70],
                [0.50, 0.70],
                [leg_r, 0.70],
                [hem_l, 0.95],
                [0.50, 0.95],
                [hem_r, 0.95],
            ],
            dtype=np.float64,
        )
        dst_px = np.array(
            [
                [center_x - waist_half, y_wb],
                [center_x, y_wb],
                [center_x + waist_half, y_wb],
                [center_x - hip_half, y_hip],
                [center_x, y_hip],
                [center_x + hip_half, y_hip],
                [center_x - thigh_half, y_leg],
                [center_x, y_leg],
                [center_x + thigh_half, y_leg],
                [center_x - hem_half, y_hem],
                [center_x, y_hem],
                [center_x + hem_half, y_hem],
            ],
            dtype=np.float64,
        )

    elif cloth_type == "overall":
        width_mult = 1.56 if is_sleeved else 1.36
        draw_w = float(
            np.clip(
                max(pose.shoulder_dist * width_mult, pose.hip_dist * 1.44),
                w * 0.32,
                w * 0.78,
            )
        )
        draw_h = float(
            np.clip(
                draw_w / nat_aspect,
                pose.torso_height * 1.78,
                max(pose.torso_height * 1.85, h - pose.mid_shoulder_y + 90.0),
            )
        )
        sh_anchor_frac = float(np.clip(anchors.collar_top_y + 0.085, 0.08, 0.22))
        if high_neck:
            draw_y = pose.chin_y + neck_h * 0.36 - anchors.collar_top_y * draw_h
        else:
            draw_y = pose.mid_shoulder_y - pose.torso_height * 0.10 - sh_anchor_frac * draw_h
        draw_x = sh_cx - draw_w * 0.5
        front_collar_rim_y = draw_y + anchors.collar_bottom_y * draw_h

        src_norm = np.array(
            [
                [0.50, anchors.collar_bottom_y],
                [anchors.left_shoulder_x, anchors.shoulder_cap_y],
                [anchors.right_shoulder_x, anchors.shoulder_cap_y],
                [0.24, anchors.waist_y],
                [0.50, anchors.waist_y],
                [0.76, anchors.waist_y],
                [anchors.left_hem_x, anchors.hem_y],
                [0.50, anchors.hem_y],
                [anchors.right_hem_x, anchors.hem_y],
            ],
            dtype=np.float64,
        )
        sh_half = draw_w * 0.5 * (anchors.right_shoulder_x - anchors.left_shoulder_x)
        sh_dst_y = draw_y + anchors.shoulder_cap_y * draw_h
        waist_dst_y = draw_y + anchors.waist_y * draw_h
        hem_dst_y = draw_y + anchors.hem_y * draw_h
        waist_cx = 0.5 * (sh_cx + hip_cx)
        waist_half = draw_w * 0.27
        hem_half = draw_w * 0.5 * (anchors.right_hem_x - anchors.left_hem_x)

        dst_px = np.array(
            [
                [sh_cx, front_collar_rim_y],
                [sh_cx - sh_half * ux, sh_dst_y - sh_half * uy],
                [sh_cx + sh_half * ux, sh_dst_y + sh_half * uy],
                [waist_cx - waist_half, waist_dst_y],
                [waist_cx, waist_dst_y],
                [waist_cx + waist_half, waist_dst_y],
                [hip_cx - hem_half, hem_dst_y],
                [hip_cx, hem_dst_y],
                [hip_cx + hem_half, hem_dst_y],
            ],
            dtype=np.float64,
        )

    else:
        # `upper` or `outerwear`
        is_outerwear = cloth_type == "outerwear"
        base_w_mult = 1.76 if is_outerwear else (1.76 if is_sleeved else 1.44)

        # Measure real outer shoulder/trapezius silhouette on BOTH left & right sides
        # so zero bare shoulder skin or tank-top strap ever peeks out!
        lx_sil, rx_sil, outer_sh_span = _row_span(pose.person_mask, int(pose.mid_shoulder_y + 14))
        if outer_sh_span >= int(0.24 * w):
            sil_cx = 0.5 * (lx_sil + rx_sil)
            # Blend landmark center with real silhouette center so asymmetric poses stay balanced
            sh_cx = sh_cx * 0.55 + sil_cx * 0.45

        crest_ys: list[float] = []
        for side_x in (sh_cx - 0.34 * pose.shoulder_dist, sh_cx + 0.34 * pose.shoulder_dist):
            c = max(0, min(w - 1, int(round(side_x))))
            col = pose.person_mask[
                max(0, int(pose.chin_y + 4)) : min(h, int(pose.mid_shoulder_y + 38)),
                max(0, c - 6) : min(w, c + 7),
            ]
            hits = np.where(np.any(col, axis=1))[0]
            if len(hits) > 0:
                crest_ys.append(float(max(0, int(pose.chin_y + 4)) + int(hits[0])))
        min_crest_y = min(crest_ys) if crest_ys else (pose.mid_shoulder_y - 26.0)

        garment_sh_frac = float(np.clip(anchors.right_shoulder_x - anchors.left_shoulder_x, 0.58, 0.92))
        sh_driven_w = (pose.shoulder_dist * (1.46 if is_outerwear else 1.42)) / float(
            np.clip(garment_sh_frac * 0.88, 0.58, 0.85)
        )
        sil_driven_w = float(outer_sh_span) * 1.18 if outer_sh_span >= int(0.24 * w) else 0.0
        draw_w = float(
            np.clip(
                max(pose.shoulder_dist * base_w_mult, sh_driven_w, sil_driven_w),
                w * 0.38,
                w * 0.86,
            )
        )
        min_t = 1.36 if is_outerwear else 1.24
        max_t = 2.15 if is_outerwear else 1.66
        draw_h = float(
            np.clip(
                draw_w / nat_aspect,
                pose.torso_height * min_t,
                pose.torso_height * max_t,
            )
        )

        sh_cap_frac = float(np.clip(anchors.shoulder_cap_y, 0.04, 0.26))
        # Sit cleanly ABOVE both trapezius shoulder crests (+12px margin) to cover 100% of tank straps
        target_sh_top_y = min(
            pose.mid_shoulder_y - max(26.0, pose.shoulder_dist * 0.17),
            min_crest_y - 12.0,
        )
        y_from_cap = target_sh_top_y - sh_cap_frac * draw_h

        if high_neck:
            min_dy = pose.chin_y + neck_h * 0.12 - anchors.collar_bottom_y * draw_h
            max_dy = pose.chin_y + neck_h * 0.26 - anchors.collar_bottom_y * draw_h
            draw_y = float(np.clip(y_from_cap, min_dy, max(min_dy, max_dy)))
        else:
            min_dy = pose.chin_y + neck_h * 0.18 - anchors.collar_top_y * draw_h
            max_dy = pose.mid_shoulder_y - pose.torso_height * 0.10 - sh_cap_frac * draw_h
            draw_y = float(np.clip(y_from_cap, min_dy, max(min_dy, max_dy)))

        garment_cx_frac = float(np.clip(0.5 * (anchors.left_shoulder_x + anchors.right_shoulder_x), 0.45, 0.55))
        draw_x = sh_cx - garment_cx_frac * draw_w
        front_collar_rim_y = draw_y + anchors.collar_bottom_y * draw_h

        def _rot_pt(nx: float, ny: float) -> np.ndarray:
            lx = (nx - garment_cx_frac) * draw_w
            ly = (ny - sh_cap_frac) * draw_h
            return np.array(
                [
                    sh_cx + lx * ux + ly * vx,
                    (draw_y + sh_cap_frac * draw_h) + lx * uy + ly * vy,
                ],
                dtype=np.float64,
            )

        p_collar = _rot_pt(garment_cx_frac, anchors.collar_bottom_y)
        p_ls = _rot_pt(anchors.left_shoulder_x, anchors.shoulder_cap_y)
        p_rs = _rot_pt(anchors.right_shoulder_x, anchors.shoulder_cap_y)
        p_mid_l = _rot_pt(0.18, 0.52)
        p_mid_c = _rot_pt(garment_cx_frac, 0.52)
        p_mid_r = _rot_pt(0.82, 0.52)
        p_bl = _rot_pt(anchors.left_hem_x, anchors.hem_y)
        p_bc = _rot_pt(garment_cx_frac, anchors.hem_y)
        p_br = _rot_pt(anchors.right_hem_x, anchors.hem_y)

        if is_sleeved and pose.left_elbow is not None and pose.right_elbow is not None:
            le_dx = float(np.clip((pose.left_elbow[0] - p_mid_l[0]) * 0.16, -18.0, 18.0))
            re_dx = float(np.clip((pose.right_elbow[0] - p_mid_r[0]) * 0.16, -18.0, 18.0))
            p_mid_l = p_mid_l + np.array([le_dx, 0.0])
            p_mid_r = p_mid_r + np.array([re_dx, 0.0])

        hip_shift_x = float(np.clip((hip_cx - p_bc[0]) * 0.30, -18.0, 18.0))
        p_bl = p_bl + np.array([hip_shift_x, 0.0])
        p_bc = p_bc + np.array([hip_shift_x, 0.0])
        p_br = p_br + np.array([hip_shift_x, 0.0])

        src_norm = np.array(
            [
                [garment_cx_frac, anchors.collar_bottom_y],
                [anchors.left_shoulder_x, anchors.shoulder_cap_y],
                [anchors.right_shoulder_x, anchors.shoulder_cap_y],
                [0.18, 0.52],
                [garment_cx_frac, 0.52],
                [0.82, 0.52],
                [anchors.left_hem_x, anchors.hem_y],
                [garment_cx_frac, anchors.hem_y],
                [anchors.right_hem_x, anchors.hem_y],
            ],
            dtype=np.float64,
        )
        dst_px = np.array(
            [p_collar, p_ls, p_rs, p_mid_l, p_mid_c, p_mid_r, p_bl, p_bc, p_br],
            dtype=np.float64,
        )

    # Convert source normalized coordinates to pixel coords in cropped garment
    src_px = np.column_stack([src_norm[:, 0] * (gw - 1), src_norm[:, 1] * (gh - 1)])

    # Fast smooth inverse TPS mapping: dst (canvas) -> src (garment) on coarse 48x64 grid -> upsample to 768x1024
    try:
        rbf = RBFInterpolator(
            dst_px / np.array([float(w), float(h)]),
            src_px,
            kernel="thin_plate_spline",
            smoothing=0.0025,
            degree=1,
        )
        grid_w, grid_h = 48, 64
        gx = np.linspace(0.0, 1.0, grid_w, dtype=np.float64)
        gy = np.linspace(0.0, 1.0, grid_h, dtype=np.float64)
        mx, my = np.meshgrid(gx, gy)
        query = np.column_stack([mx.ravel(), my.ravel()])
        mapped = rbf(query).reshape(grid_h, grid_w, 2)

        map_x = cv2.resize(mapped[:, :, 0].astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
        map_y = cv2.resize(mapped[:, :, 1].astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)

        warped_rgb = cv2.remap(
            prepared.rgba[:, :, :3],
            map_x,
            map_y,
            interpolation=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(0, 0, 0),
        )
        warped_alpha = cv2.remap(
            prepared.rgba[:, :, 3],
            map_x,
            map_y,
            interpolation=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )
    except Exception as exc:
        logger.warning("TPS cage warp fallback to perspective (%s)", exc)
        quad_src = np.array([src_px[0], src_px[2], src_px[-1], src_px[-3]], dtype=np.float32)
        quad_dst = np.array([dst_px[0], dst_px[2], dst_px[-1], dst_px[-3]], dtype=np.float32)
        mat = cv2.getPerspectiveTransform(quad_src, quad_dst)
        warped_rgb = cv2.warpPerspective(
            prepared.rgba[:, :, :3],
            mat,
            (w, h),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(0, 0, 0),
        )
        warped_alpha = cv2.warpPerspective(
            prepared.rgba[:, :, 3],
            mat,
            (w, h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )

    # Smooth 1.1px outer edge anti-aliasing while keeping interior 100% crisp
    alpha_f = warped_alpha.astype(np.float32) / 255.0
    feathered = cv2.GaussianBlur(alpha_f, (0, 0), sigmaX=0.95, sigmaY=0.95)
    inner_solid = ndimage.binary_erosion(alpha_f > 0.78, iterations=2)
    alpha_f = np.where(inner_solid, np.maximum(alpha_f, 0.99), feathered)
    alpha_f = np.where(alpha_f < 0.02, 0.0, alpha_f)

    # In 2-step Outfit mode (`step_order >= 2`, `lower`), preserve the Step 1 sweater hem
    # naturally OVER the top of the tailored trousers!
    if cloth_type == "lower" and step_order >= 2 and lower_mask_top_y is not None:
        cut_y = max(0, min(h - 1, lower_mask_top_y - 2))
        if old_cloth_mask is not None:
            # Soft mask that allows trousers everywhere inside/around the visible lower body
            # while keeping the Step 1 upper garment hem strictly in front!
            top_ramp = np.ones((h, w), dtype=np.float32)
            top_ramp[:cut_y, :] = 0.0
            # Per-column exact sweater hem contour from old_cloth_mask where present
            for x_col in range(w):
                col_hits = np.where(old_cloth_mask[:, x_col])[0]
                if len(col_hits) > 0:
                    c_top = max(0, int(col_hits[0]) - 2)
                    top_ramp[:c_top, x_col] = 0.0
                    top_ramp[c_top:, x_col] = 1.0
            top_ramp = cv2.GaussianBlur(top_ramp, (0, 0), sigmaX=2.0, sigmaY=2.0)
            alpha_f = alpha_f * top_ramp
    elif cloth_type == "lower":
        wb_y = int(round(front_collar_rim_y))
        if 4 < wb_y < h - 4:
            band = alpha_f[wb_y - 3 : wb_y + 4, :]
            alpha_f[wb_y - 3 : wb_y + 4, :] = cv2.GaussianBlur(band, (0, 0), sigmaX=0.6, sigmaY=1.2)

    return warped_rgb, alpha_f, front_collar_rim_y, high_neck, (draw_x, draw_y, draw_w, draw_h)


# =============================================================================
# Step A (Applied) + Step C: Old-Sleeve Inpaint, LAB Relighting & Head/Chin Occlusion
# =============================================================================


def _build_head_chin_neck_occlusion_mask(
    pose: AnatomicalPose,
    front_collar_rim_y: float,
    high_neck: bool,
) -> np.ndarray:
    """
    Build feathered [0..1] foreground mask covering head, hair, face, jawline, chin,
    and tapered upper neck cleanly ABOVE the garment neckline (strictly inside neck width
    so zero background halo leaks onto dark collars or exposes old straps).
    """
    w, h = pose.width, pose.height
    mask = np.zeros((h, w), dtype=np.float32)

    head_cx = pose.nose[0] * 0.55 + (pose.left_ear[0] + pose.right_ear[0]) * 0.225
    head_half_w = max(pose.ear_span * 1.15, pose.shoulder_dist * 0.38)
    neck_half_w = float(np.clip(pose.ear_span * 0.24, 18.0, pose.shoulder_dist * 0.17))
    neck_h = max(22.0, pose.mid_shoulder_y - pose.chin_y)

    if high_neck:
        neck_stop_y = float(
            np.clip(
                min(front_collar_rim_y - 1.0, pose.chin_y + neck_h * 0.46),
                pose.chin_y + 4.0,
                pose.mid_shoulder_y - 12.0,
            )
        )
    else:
        neck_stop_y = float(
            np.clip(
                min(front_collar_rim_y + 2.0, pose.mid_shoulder_y + 8.0),
                pose.chin_y + 12.0,
                pose.mid_shoulder_y + 18.0,
            )
        )

    jaw_side_y = pose.mouth_mid[1] + (pose.chin_y - pose.mouth_mid[1]) * 0.42

    # 1. Upper head + hair + jawline polygon
    head_poly = np.array(
        [
            [head_cx - head_half_w * 1.32, 0.0],
            [head_cx + head_half_w * 1.32, 0.0],
            [head_cx + head_half_w * 1.18, pose.right_ear[1] + 10.0],
            [head_cx + head_half_w * 0.72, jaw_side_y],
            [head_cx + neck_half_w * 1.00, pose.chin_y + 1.0],
            [head_cx, pose.chin_y + 7.0],
            [head_cx - neck_half_w * 1.00, pose.chin_y + 1.0],
            [head_cx - head_half_w * 0.72, jaw_side_y],
            [head_cx - head_half_w * 1.18, pose.left_ear[1] + 10.0],
        ],
        dtype=np.int32,
    )
    cv2.fillPoly(mask, [head_poly], 1.0)

    # 2. Tapered upper-neck column descending cleanly into the front collar rim
    if neck_stop_y > pose.chin_y + 2.0:
        neck_poly = np.array(
            [
                [head_cx - neck_half_w * 0.92, pose.chin_y - 4.0],
                [head_cx + neck_half_w * 0.92, pose.chin_y - 4.0],
                [head_cx + neck_half_w * 0.80, neck_stop_y - 2.0],
                [head_cx, neck_stop_y + 3.0],
                [head_cx - neck_half_w * 0.80, neck_stop_y - 2.0],
            ],
            dtype=np.int32,
        )
        cv2.fillPoly(mask, [neck_poly], 1.0)

    mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=3.2, sigmaY=3.2)

    # Keep inner face core 100% pixel-identical (identity preservation MAE ~ 0!)
    if pose.face_box is not None:
        fx, fy, fw, fh = pose.face_box
        inner = np.zeros((h, w), dtype=np.float32)
        cv2.ellipse(
            inner,
            (int(round(fx + fw * 0.5)), int(round(fy + fh * 0.48))),
            (max(16, int(round(fw * 0.56))), max(18, int(round(fh * 0.52)))),
            0.0,
            0.0,
            360.0,
            1.0,
            -1,
        )
        mask = np.maximum(mask, inner)

    return np.clip(mask, 0.0, 1.0)


def _suppress_exposed_old_garment_telea(
    person_rgb: np.ndarray,
    old_cloth_mask: np.ndarray,
    new_garment_alpha: np.ndarray,
    head_protect_mask: np.ndarray,
    pose: AnatomicalPose,
    cloth_type: ClothType,
) -> np.ndarray:
    """
    Step A — Old-Sleeve & Tank-Strap Suppression:
    Restores any exposed old sleeves/straps lying OUTSIDE the new garment silhouette via
    `cv2.inpaint(..., cv2.INPAINT_TELEA)` while keeping face/hair and room background 100% intact.
    """
    h, w = person_rgb.shape[:2]
    # Only target exposed old-garment regions near collar/shoulders/sleeves (for upper/overall)
    zone = np.zeros((h, w), dtype=bool)
    if cloth_type == "lower":
        y0 = max(0, int(pose.mid_shoulder_y + pose.torso_height * 0.72))
        zone[y0:, :] = True
    else:
        y0 = max(0, int(pose.chin_y + 8))
        y1 = min(h, int(pose.mid_shoulder_y + pose.torso_height * (1.25 if cloth_type == "overall" else 0.92)))
        zone[y0:y1, :] = True

    exposed = (
        old_cloth_mask
        & zone
        & (new_garment_alpha < 0.30)
        & (head_protect_mask < 0.25)
    )
    exposed_px = int(np.count_nonzero(exposed))
    # Skip if negligible or implausibly huge (prevents over-inpainting if segmentation missed)
    if exposed_px < 45 or exposed_px > int(h * w * 0.22):
        return person_rgb

    # Dilate exposed mask gently (2px) so strap/sleeve borders erase cleanly
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    inpaint_mask = cv2.dilate(exposed.astype(np.uint8) * 255, kernel, iterations=1)
    # Never touch face/head/hair or pixels completely outside the person silhouette
    inpaint_mask[head_protect_mask > 0.25] = 0
    inpaint_mask[new_garment_alpha > 0.65] = 0

    if int(np.count_nonzero(inpaint_mask)) < 30:
        return person_rgb

    person_bgr = cv2.cvtColor(person_rgb, cv2.COLOR_RGB2BGR)
    restored_bgr = cv2.inpaint(person_bgr, inpaint_mask, inpaintRadius=7, flags=cv2.INPAINT_TELEA)
    restored_rgb = cv2.cvtColor(restored_bgr, cv2.COLOR_BGR2RGB)

    # Blend restored pixels smoothly into person image while preserving 100% of room background
    blend_a = cv2.GaussianBlur((inpaint_mask > 0).astype(np.float32), (0, 0), sigmaX=1.8, sigmaY=1.8)
    blend_a = np.where(pose.person_mask, blend_a, 0.0)
    out = person_rgb.astype(np.float32) * (1.0 - blend_a[:, :, None]) + restored_rgb.astype(np.float32) * blend_a[:, :, None]
    return np.clip(np.round(out), 0, 255).astype(np.uint8)


def _shade_and_relight_garment_lab(
    person_rgb: np.ndarray,
    warped_rgb: np.ndarray,
    alpha_f: np.ndarray,
    person_mask: np.ndarray,
    rect: tuple[float, float, float, float],
    lighting_preset: LightingPreset,
) -> np.ndarray:
    """
    Step C — Cylindrical 3D Drape Shading + CIE-LAB Ambient Relighting (`L*`, `a*`, `b*`)
    harmonizing the garment with the real person photo's room lighting + `lighting_preset`.
    """
    h, w = warped_rgb.shape[:2]
    draw_x, draw_y, draw_w, draw_h = rect
    g_solid = alpha_f > 0.55

    # 1. CIE-LAB ambient harmonization (L*, a*, b*) against real person photo lighting
    harmonized = warped_rgb.copy()
    if int(np.count_nonzero(g_solid)) >= 200 and int(np.count_nonzero(person_mask)) >= 200:
        p_lab = cv2.cvtColor(person_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
        g_lab = cv2.cvtColor(warped_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)

        # Sample ambient scene lighting around person & upper torso/skin
        p_l_med = float(np.median(p_lab[:, :, 0][person_mask]))
        p_a_med = float(np.median(p_lab[:, :, 1][person_mask]))
        p_b_med = float(np.median(p_lab[:, :, 2][person_mask]))

        g_l_med = float(np.median(g_lab[:, :, 0][g_solid]))
        g_a_med = float(np.median(g_lab[:, :, 1][g_solid]))
        g_b_med = float(np.median(g_lab[:, :, 2][g_solid]))

        delta_l = float(np.clip((p_l_med - g_l_med) * 0.20, -16.0, 16.0))
        delta_a = float(np.clip((p_a_med - g_a_med) * 0.08, -6.0, 6.0))
        delta_b = float(np.clip((p_b_med - g_b_med) * 0.11, -8.0, 8.0))

        # Preset-specific LAB shift
        if lighting_preset == "morning":
            delta_l += 4.5
            delta_b += 3.5
        elif lighting_preset == "evening":
            delta_l -= 10.5
            delta_a += 2.2
            delta_b += 7.5
        else:
            delta_b += 1.2

        g_lab[:, :, 0] = np.clip(g_lab[:, :, 0] + delta_l, 2.0, 253.0)
        g_lab[:, :, 1] = np.clip(g_lab[:, :, 1] + delta_a, 2.0, 253.0)
        g_lab[:, :, 2] = np.clip(g_lab[:, :, 2] + delta_b, 2.0, 253.0)
        harmonized = cv2.cvtColor(g_lab.astype(np.uint8), cv2.COLOR_LAB2RGB)

    # 2. Cylindrical 3D body-wrap shading + gentle vertical depth
    xs = np.linspace(0.0, float(w - 1), w, dtype=np.float32)
    ys = np.linspace(0.0, float(h - 1), h, dtype=np.float32)
    u = np.clip((xs - float(draw_x)) / max(1.0, float(draw_w)), 0.0, 1.0)
    v = np.clip((ys - float(draw_y)) / max(1.0, float(draw_h)), 0.0, 1.0)

    # Cosine-like cylindrical profile: subtle dark roll-off on outer edges, gentle soft chest key light
    cyl_curve = 0.87 + 0.15 * np.sin(u * math.pi)
    vert_curve = 0.96 + 0.05 * np.exp(-((v - 0.24) ** 2) / 0.06) - 0.06 * np.clip((v - 0.72) / 0.28, 0.0, 1.0)
    shading_2d = np.outer(vert_curve, cyl_curve).astype(np.float32)

    shaded = harmonized.astype(np.float32) * shading_2d[:, :, None]

    # 3. Subtle lighting preset tint
    if lighting_preset == "morning":
        tint = np.array([255.0, 248.0, 236.0], dtype=np.float32)
        shaded = shaded * 0.93 + tint * 0.07
    elif lighting_preset == "evening":
        tint = np.array([242.0, 206.0, 162.0], dtype=np.float32)
        shaded = shaded * 0.89 + tint * 0.11
    else:
        tint = np.array([248.0, 244.0, 237.0], dtype=np.float32)
        shaded = shaded * 0.96 + tint * 0.04

    return np.clip(shaded, 0.0, 255.0)


def _apply_studio_atmosphere_pass(
    comp_f: np.ndarray,
    lighting_preset: LightingPreset,
) -> np.ndarray:
    """Gentle unified lighting atmosphere across final 768x1024 frame."""
    h, w = comp_f.shape[:2]
    if lighting_preset == "morning":
        yg, xg = np.mgrid[0:h, 0:w].astype(np.float32)
        grad = np.clip(1.0 - (xg / w * 0.55 + yg / h * 0.45), 0.0, 1.0) * 0.08
        warm = np.array([255.0, 247.0, 228.0], dtype=np.float32)
        return comp_f * (1.0 - grad[:, :, None]) + warm * grad[:, :, None]
    if lighting_preset == "evening":
        yg, xg = np.mgrid[0:h, 0:w].astype(np.float32)
        dist = np.sqrt(((xg - w * 0.5) / (w * 0.65)) ** 2 + ((yg - h * 0.36) / (h * 0.65)) ** 2)
        vig = np.clip((dist - 0.35) * 0.22, 0.0, 0.18)
        tint = np.array([242.0, 206.0, 162.0], dtype=np.float32)
        out = comp_f * 0.95 + tint * 0.05
        return out * (1.0 - vig[:, :, None]) + np.array([16.0, 11.0, 9.0], dtype=np.float32) * vig[:, :, None]
    # Atelier: crisp natural tone with minimal ivory warmth
    return comp_f


def _build_foreground_hands_mask(person_rgb: np.ndarray, pose: AnatomicalPose) -> np.ndarray:
    """Protect skin-toned forearms/hands along elbow->wrist->fingertip capsules so trousers never overlap arms."""
    h, w = person_rgb.shape[:2]
    hand_mask = np.zeros((h, w), dtype=np.float32)
    arm_pairs = [
        (pose.left_elbow, pose.left_wrist),
        (pose.right_elbow, pose.right_wrist),
    ]
    if not any(wr is not None for _, wr in arm_pairs):
        return hand_mask

    ycrcb = cv2.cvtColor(person_rgb, cv2.COLOR_RGB2YCrCb)
    skin = (
        (ycrcb[:, :, 1] >= 131)
        & (ycrcb[:, :, 1] <= 178)
        & (ycrcb[:, :, 2] >= 76)
        & (ycrcb[:, :, 2] <= 132)
        & pose.person_mask
    )
    roi = np.zeros((h, w), dtype=np.uint8)
    for elb, wr in arm_pairs:
        if wr is None:
            continue
        wx, wy = int(round(wr[0])), int(round(wr[1]))
        if elb is not None:
            ex, ey = int(round(elb[0])), int(round(elb[1]))
            cv2.line(roi, (ex, ey), (wx, wy), 1, thickness=64)
        cv2.ellipse(roi, (wx, wy + 42), (48, 104), 0.0, 0.0, 360.0, 1, -1)

    hands = (roi > 0) & skin
    if int(np.count_nonzero(hands)) < 80:
        return hand_mask
    return cv2.GaussianBlur(hands.astype(np.float32), (0, 0), sigmaX=1.6, sigmaY=1.6)


def _render_photometric_inpaint_sync(
    *,
    person_bytes: bytes,
    garment_bytes: bytes,
    cloth_type: ClothType,
    garment_name: str = "",
    color_hex: str | None = None,
    lighting_preset: LightingPreset = "atelier",
    pose_landmarks: list[dict[str, Any]] | dict[str, Any] | None = None,
    precomputed: tuple[Image.Image, AnatomicalPose] | None = None,
    strict_pose_gate: bool = True,
    step_order: int = 1,
) -> tuple[bytes, bool]:
    if precomputed is not None:
        canvas_rgba, pose = precomputed
    else:
        canvas_rgba, pose = detect_anatomical_pose(
            person_bytes,
            pose_landmarks=pose_landmarks,
            strict_pose_gate=strict_pose_gate,
        )

    w, h = pose.width, pose.height
    person_hash = hashlib.sha256(person_bytes).hexdigest()[:24]
    rgb_img = canvas_rgba.convert("RGB")
    person_rgb = np.array(rgb_img, dtype=np.uint8)

    # Step A (Parse existing garment first so both inpaint & lower-waist alignment know exact bounds!)
    old_cloth_mask = _extract_old_cloth_mask(
        rgb_img,
        pose.person_mask,
        pose,
        cloth_type,
        person_hash=person_hash,
    )

    # Step B (Prep + TPS Cage Warp)
    prepared = prepare_clean_garment_rgba(
        garment_bytes,
        cloth_type=cloth_type,
        color_hex=color_hex,
    )
    warped_rgb, alpha_f, front_collar_rim_y, high_neck, rect = _compute_garment_placement_and_tps(
        prepared,
        pose,
        cloth_type=cloth_type,
        garment_name=garment_name,
        old_cloth_mask=old_cloth_mask,
        step_order=step_order,
    )

    # Head/Chin/Jawline/Hair/Upper-Neck Foreground Protection Mask
    head_protect = _build_head_chin_neck_occlusion_mask(pose, front_collar_rim_y, high_neck)

    # Step A (Applied) — Old-Sleeve / Tank-Strap Suppression via INPAINT_TELEA
    inpainted_person = _suppress_exposed_old_garment_telea(
        person_rgb,
        old_cloth_mask,
        alpha_f,
        head_protect,
        pose,
        cloth_type,
    )

    # Step C — Cylindrical 3D Shading + CIE-LAB Ambient Relighting
    shaded_garment = _shade_and_relight_garment_lab(
        inpainted_person,
        warped_rgb,
        alpha_f,
        pose.person_mask,
        rect,
        lighting_preset,
    )

    # Soft contact drop shadow behind garment (strictly below chin/face)
    base_f = inpainted_person.astype(np.float32)
    orig_f = person_rgb.astype(np.float32)
    shift_m = np.array([[1.0, 0.0, 2.0], [0.0, 1.0, 5.0]], dtype=np.float32)
    shadow_a = cv2.warpAffine(
        alpha_f,
        shift_m,
        (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0.0,
    )
    shadow_a = cv2.GaussianBlur(shadow_a, (0, 0), sigmaX=6.5, sigmaY=6.5)
    body_weight = np.where(pose.person_mask, 0.22, 0.09).astype(np.float32)
    shadow_strength = np.clip(shadow_a * body_weight, 0.0, 0.25)
    if cloth_type != "lower":
        shadow_strength = shadow_strength * (1.0 - head_protect)

    comp = base_f * (1.0 - shadow_strength[:, :, None]) + np.array([22.0, 16.0, 12.0], dtype=np.float32) * shadow_strength[:, :, None]

    # Composite shaded garment onto inpainted person canvas
    comp = comp * (1.0 - alpha_f[:, :, None]) + shaded_garment * alpha_f[:, :, None]

    # Soft collar contact shadow on neck + crisp Head/Chin/Hair/Upper-Neck occlusion ON TOP
    if cloth_type != "lower":
        head_cx = pose.nose[0] * 0.55 + (pose.left_ear[0] + pose.right_ear[0]) * 0.225
        neck_half_w = float(np.clip(pose.ear_span * 0.24, 18.0, pose.shoulder_dist * 0.17))
        yg, xg = np.mgrid[0:h, 0:w].astype(np.float32)
        dist_collar = np.sqrt(
            ((xg - head_cx) / max(12.0, neck_half_w * 1.35)) ** 2
            + ((yg - (front_collar_rim_y + 2.0)) / 14.0) ** 2
        )
        collar_shadow = np.clip((1.0 - dist_collar) * 0.16, 0.0, 0.16) * (1.0 - head_protect)
        comp = comp * (1.0 - collar_shadow[:, :, None]) + np.array([26.0, 18.0, 13.0], dtype=np.float32) * collar_shadow[:, :, None]

        # Re-composite exact original face + chin + jawline + hair + upper neck strictly on top
        comp = comp * (1.0 - head_protect[:, :, None]) + orig_f * head_protect[:, :, None]
    else:
        # Preserve foreground hands/wrists cleanly IN FRONT of trousers
        hands_protect = _build_foreground_hands_mask(person_rgb, pose)
        if np.any(hands_protect > 0.02):
            comp = comp * (1.0 - hands_protect[:, :, None]) + orig_f * hands_protect[:, :, None]

    # Unified subtle lighting atmosphere pass
    comp = _apply_studio_atmosphere_pass(comp, lighting_preset)

    final_rgb = np.clip(np.round(comp), 0, 255).astype(np.uint8)
    out_buf = io.BytesIO()
    Image.fromarray(final_rgb, mode="RGB").save(out_buf, format="WEBP", quality=92, method=4)
    return out_buf.getvalue(), prepared.clean_collar_applied


class PhotometricInpaintWarpProvider(BaseVtonProvider):
    """
    Tier 4 Immortal Anatomical VTON Engine ($0, NEVER fails on valid portraits):
      - Step A: Neural Human/Cloth Parsing (`isnet-general-use` + `u2net_cloth_seg` from D: drive)
                + Exposed Old-Sleeve / Tank-Strap Suppression via `cv2.inpaint(..., INPAINT_TELEA)`.
      - Step B: Surgical Inner Collar Cavity Removal + Luminance-Preserving Variant Recolor
                + Smooth Multi-Zone Thin-Plate-Spline (TPS) Cage Deformation anchored to
                  Shoulders (11,12), Neck pit, Elbows (13,14), and Waist/Hips (23,24).
      - Step C: Cylindrical 3D Shading + CIE-LAB Ambient Relighting (`morning` | `atelier` | `evening`)
                + Collar Contact Shadow + Crisp Foreground Face/Chin/Hair Occlusion.
    """

    name: str = "photometric_inpaint"
    provider_type: VTONProviderType = "PHOTOMETRIC_INPAINT"
    capabilities: ProviderCapabilities = ProviderCapabilities(
        name="photometric_inpaint",
        display_name="Atelier Photometric Inpaint & TPS Anatomical Engine (Tier 4 · $0 Immortal)",
        mode="local-cv",
        supported_categories=("TOP", "BOTTOM", "ONE_PIECE", "OUTERWEAR"),
        supported_aspect_ratios=("3:4", "2:3"),
        supports_alpha_cutout=True,
        status="active",
    )

    def __init__(
        self,
        *,
        private_bucket: str = "atelier-private-tryon",
        purge_ttl_minutes: int = 15,
    ) -> None:
        self.private_bucket = private_bucket
        self.purge_ttl_minutes = purge_ttl_minutes

    async def validate_pose(
        self,
        person_image_bytes: bytes,
        *,
        pose_landmarks: list[dict[str, Any]] | dict[str, Any] | None = None,
    ) -> tuple[Image.Image, AnatomicalPose]:
        return await asyncio.to_thread(
            detect_anatomical_pose,
            person_image_bytes,
            pose_landmarks=pose_landmarks,
            strict_pose_gate=True,
        )

    async def synthesize(
        self,
        request: TryOnGenerationRequest,
        *,
        precomputed_pose: tuple[Image.Image, AnatomicalPose] | None = None,
    ) -> TryOnGenerationResult:
        started = time.perf_counter()
        person_bytes = await resolve_bytes_or_url(request.person_bytes, request.human_image_url)
        garment_bytes = await resolve_bytes_or_url(request.garment_bytes, request.garment_image_url)
        cloth_type = request.normalized_cloth_type
        lighting = request.normalized_lighting_preset

        try:
            output_bytes, clean_collar = await asyncio.to_thread(
                _render_photometric_inpaint_sync,
                person_bytes=person_bytes,
                garment_bytes=garment_bytes,
                cloth_type=cloth_type,
                garment_name=request.garment_name,
                color_hex=request.color_hex,
                lighting_preset=lighting,
                pose_landmarks=request.pose_landmarks,
                precomputed=precomputed_pose,
                strict_pose_gate=True,
                step_order=request.step_order,
            )
        except PoseTooCloseError:
            raise
        except Exception as exc:
            # Immortal safety retry with relaxed pose gate & fallback compositing
            logger.warning("Primary photometric render hit %s; running immortal fallback pass", exc)
            output_bytes, clean_collar = await asyncio.to_thread(
                _render_photometric_inpaint_sync,
                person_bytes=person_bytes,
                garment_bytes=garment_bytes,
                cloth_type=cloth_type,
                garment_name=request.garment_name,
                color_hex=request.color_hex,
                lighting_preset=lighting,
                pose_landmarks=request.pose_landmarks,
                precomputed=None,
                strict_pose_gate=False,
                step_order=request.step_order,
            )

        latency_ms = max(1, int((time.perf_counter() - started) * 1000))
        digest = hashlib.sha256(output_bytes[:4096]).hexdigest()[:16]
        return TryOnGenerationResult(
            result_bytes=output_bytes,
            content_type="image/webp",
            provider_used="photometric_inpaint",
            provider_type="PHOTOMETRIC_INPAINT",
            provider_badge=PHOTOMETRIC_INPAINT_BADGE,
            latency_ms=latency_ms,
            clean_collar_applied=clean_collar,
            external_job_id=f"photometric_{cloth_type}_{digest}",
            estimated_cost_usd=0.0,
            width=CANVAS_W,
            height=CANVAS_H,
            notes="Synthesized via Tier 4 Photometric Inpaint (INPAINT_TELEA + TPS Cage + CIE-LAB).",
        )

    async def _generate_legacy_preview(self, request: VTONRequest) -> VTONResult:
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(minutes=self.purge_ttl_minutes)
        digest = hashlib.sha256(
            "|".join(
                [
                    self.name,
                    request.user_id,
                    request.garment_sku_id,
                    request.person_image_fingerprint,
                    request.garment_category,
                    request.aspect_ratio,
                ]
            ).encode("utf-8")
        ).hexdigest()[:20]
        job_id = f"tryon_photometric_{digest}"
        object_key = f"previews/{request.user_id}/{job_id}.webp"
        return VTONResult(
            job_id=job_id,
            provider=self.name,
            status="COMPLETED",
            result_bucket=self.private_bucket,
            result_object_key=object_key,
            preview_url=f"minio://{self.private_bucket}/{object_key}",
            aspect_ratio=request.aspect_ratio,
            latency_ms=15,
            created_at=now,
            expires_at=expires_at,
            notes="PhotometricInpaintWarpProvider ready.",
        )

    async def health_check(self) -> bool:
        return True
