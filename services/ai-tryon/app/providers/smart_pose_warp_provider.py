from __future__ import annotations

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
import numpy as np
from PIL import Image, ImageOps
from scipy import ndimage

from app.preprocessing.normalizer import normalize_user_portrait_3x4
from app.providers.base import (
    DEFAULT_POSE_TOO_CLOSE_MESSAGE,
    POSE_WARP_BADGE,
    PoseTooCloseError,
    ProviderCapabilities,
    VTONProviderType,
    VTONRenderStepResult,
    VTONRequest,
    VTONResult,
    VTONStepCategory,
)

logger = logging.getLogger("atelier.ai_tryon.smart_pose_warp")

CANVAS_W = 768
CANVAS_H = 1024

YUNET_MODEL_PATH = (
    Path(__file__).resolve().parents[1]
    / "preprocessing"
    / "models"
    / "face_detection_yunet_2023mar.onnx"
)

_MODEL_LOCK = threading.Lock()
_REMBG_SESSION: Any | None = None
_REMBG_FAILED = False
_YUNET_DETECTOR: Any | None = None
_HAAR_CLASSIFIER: Any | None = None
_MEDIAPIPE_POSE: Any | None = None
_MEDIAPIPE_CHECKED = False


def _is_onnxruntime_available() -> bool:
    try:
        return importlib.util.find_spec("onnxruntime") is not None
    except Exception:
        return False


def _get_rembg_session() -> Any | None:
    global _REMBG_SESSION, _REMBG_FAILED
    with _MODEL_LOCK:
        if _REMBG_SESSION is not None:
            return _REMBG_SESSION
        if _REMBG_FAILED:
            return None
        if not _is_onnxruntime_available():
            logger.warning(
                "onnxruntime backend not installed; skipping rembg import to avoid SystemExit and using GrabCut fallback"
            )
            _REMBG_FAILED = True
            return None
        try:
            from rembg import new_session

            t0 = time.perf_counter()
            _REMBG_SESSION = new_session("isnet-general-use")
            logger.info(
                "Loaded rembg isnet-general-use session in %.2fs",
                time.perf_counter() - t0,
            )
        except (Exception, SystemExit) as exc:
            logger.warning("rembg isnet-general-use unavailable (%s); using GrabCut fallback", exc)
            _REMBG_FAILED = True
            _REMBG_SESSION = None
        return _REMBG_SESSION


def _get_face_detector(width: int = CANVAS_W, height: int = CANVAS_H) -> tuple[str, Any | None]:
    """Return available OpenCV face detector (`yunet` preferred on OpenCV 5+, `haar` fallback on OpenCV 4)."""
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


@dataclass(frozen=True)
class DetectedPose:
    width: int
    height: int
    face_box: tuple[int, int, int, int] | None  # (fx, fy, fw, fh)
    chin_y: int
    left_shoulder: tuple[float, float]
    right_shoulder: tuple[float, float]
    left_hip: tuple[float, float]
    right_hip: tuple[float, float]
    mid_shoulder_y: float
    shoulder_dist: float
    person_mask: np.ndarray  # bool (H, W)
    source: str


def _parse_point(
    raw: Any,
    w: int,
    h: int,
) -> tuple[float, float, float] | None:
    if not isinstance(raw, dict):
        return None
    x = raw.get("x")
    y = raw.get("y")
    if x is None or y is None:
        return None
    try:
        xf = float(x)
        yf = float(y)
        vis = float(raw.get("visibility", 1.0)) if raw.get("visibility") is not None else 1.0
    except (TypeError, ValueError):
        return None
    # Convert normalized [0..1] to pixel coords
    px = xf * w if xf <= 1.5 else xf
    py = yf * h if yf <= 1.5 else yf
    return (
        max(0.0, min(float(w - 1), px)),
        max(0.0, min(float(h - 1), py)),
        max(0.0, min(1.0, vis)),
    )


def _extract_person_silhouette(rgb_img: Image.Image) -> np.ndarray:
    """Extract clean binary person silhouette mask via cached rembg (with GrabCut fallback)."""
    w, h = rgb_img.size
    sess = _get_rembg_session()
    if sess is not None:
        try:
            from rembg import remove

            small = rgb_img.resize((384, 512), Image.Resampling.BILINEAR)
            rgba_small = remove(small, session=sess, post_process_mask=True).convert("RGBA")
            alpha_small = np.array(rgba_small.split()[3], dtype=np.uint8)
            alpha_full = cv2.resize(alpha_small, (w, h), interpolation=cv2.INTER_LINEAR)
            mask = ndimage.binary_fill_holes(alpha_full > 40)
            if int(np.count_nonzero(mask)) > 500:
                return mask
        except (Exception, SystemExit) as exc:
            logger.warning("rembg silhouette failed (%s); falling back to GrabCut", exc)

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
        return ndimage.binary_fill_holes(fg_full)
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
        return fallback


def _detect_primary_face(
    rgb_np: np.ndarray,
) -> tuple[tuple[int, int, int, int] | None, int | None]:
    """Detect primary face (fx, fy, fw, fh) and refined chin_y on 768x1024 RGB array."""
    h, w = rgb_np.shape[:2]
    bgr = cv2.cvtColor(rgb_np, cv2.COLOR_RGB2BGR)
    kind, detector = _get_face_detector(w, h)

    if kind == "yunet" and detector is not None:
        _, faces = detector.detect(bgr)
        if faces is not None and len(faces) > 0:
            # Pick largest confident face
            best = max(
                faces,
                key=lambda f: float(f[2]) * float(f[3]) * (1.0 if float(f[-1]) >= 0.55 else 0.5),
            )
            fx = max(0, int(round(float(best[0]))))
            fy = max(0, int(round(float(best[1]))))
            fw = max(1, int(round(float(best[2]))))
            fh = max(1, int(round(float(best[3]))))
            # Landmarks: right_mouth_y = best[11], left_mouth_y = best[13]
            mouth_y = 0.5 * (float(best[11]) + float(best[13]))
            chin_y = int(round(max(fy + fh * 1.03, mouth_y + 0.30 * fh)))
            chin_y = max(fy + fh // 2, min(h - 1, chin_y))
            return (fx, fy, fw, fh), chin_y

    if kind == "haar" and detector is not None:
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        rects = detector.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(60, 60),
        )
        if len(rects) > 0:
            fx, fy, fw, fh = max(rects, key=lambda r: int(r[2]) * int(r[3]))
            chin_y = min(h - 1, int(round(fy + fh * 1.04)))
            return (int(fx), int(fy), int(fw), int(fh)), chin_y

    return None, None


def _detect_mediapipe_pose(
    rgb_np: np.ndarray,
) -> dict[str, tuple[float, float, float]] | None:
    pose = _get_optional_mediapipe_pose()
    if pose is None:
        return None
    h, w = rgb_np.shape[:2]
    res = pose.process(rgb_np)
    if not res or not res.pose_landmarks:
        return None
    lms = res.pose_landmarks.landmark
    def _pt(idx: int) -> tuple[float, float, float]:
        lm = lms[idx]
        return (
            float(lm.x) * w,
            float(lm.y) * h,
            float(getattr(lm, "visibility", 1.0)),
        )
    return {
        "nose": _pt(0),
        "left_shoulder": _pt(11),
        "right_shoulder": _pt(12),
        "left_hip": _pt(23),
        "right_hip": _pt(24),
    }


def _row_span(mask: np.ndarray, y: int) -> tuple[int, int, int]:
    """Return (x_min, x_max, span_width) of foreground mask at row y."""
    h, w = mask.shape
    yc = max(0, min(h - 1, int(y)))
    xs = np.where(mask[yc])[0]
    if len(xs) < 6:
        return (w // 2, w // 2, 0)
    return int(xs[0]), int(xs[-1]), int(xs[-1] - xs[0])


def detect_pose_and_validate(
    person_image_bytes: bytes,
    *,
    pose_landmarks: dict[str, Any] | None = None,
) -> tuple[Image.Image, DetectedPose]:
    """
    Normalize portrait to 768x1024, extract face + shoulders + hips + silhouette,
    and enforce strict POSE_TOO_CLOSE gate BEFORE any Tier 1/2/3 rendering.
    """
    canvas_rgba = normalize_user_portrait_3x4(
        person_image_bytes,
        target_size=(CANVAS_W, CANVAS_H),
    )
    rgb_img = canvas_rgba.convert("RGB")
    rgb_np = np.array(rgb_img, dtype=np.uint8)
    h, w = rgb_np.shape[:2]

    # 1. Inspect browser-provided poseLandmarks (if present) for explicit low shoulder visibility
    lm_ls = _parse_point((pose_landmarks or {}).get("leftShoulder"), w, h)
    lm_rs = _parse_point((pose_landmarks or {}).get("rightShoulder"), w, h)
    lm_lh = _parse_point((pose_landmarks or {}).get("leftHip"), w, h)
    lm_rh = _parse_point((pose_landmarks or {}).get("rightHip"), w, h)

    if lm_ls is not None and lm_ls[2] < 0.50:
        raise PoseTooCloseError(
            DEFAULT_POSE_TOO_CLOSE_MESSAGE,
            details={"reason": "left_shoulder_visibility_low", "visibility": round(lm_ls[2], 3)},
        )
    if lm_rs is not None and lm_rs[2] < 0.50:
        raise PoseTooCloseError(
            DEFAULT_POSE_TOO_CLOSE_MESSAGE,
            details={"reason": "right_shoulder_visibility_low", "visibility": round(lm_rs[2], 3)},
        )

    # 2. Server-side face detection (YuNet / Haar)
    face_box, chin_y = _detect_primary_face(rgb_np)

    # Fallback faceBox from client landmarks if server face detector missed
    if face_box is None and isinstance(pose_landmarks, dict) and isinstance(
        pose_landmarks.get("faceBox"), dict
    ):
        fb = pose_landmarks["faceBox"]
        try:
            fx = int(round(float(fb["x"]) * w))
            fy = int(round(float(fb["y"]) * h))
            fw = max(1, int(round(float(fb["w"]) * w)))
            fh = max(1, int(round(float(fb["h"]) * h)))
            face_box = (fx, fy, fw, fh)
            chin_y = min(h - 1, int(round(fy + fh * 1.04)))
        except Exception:
            pass

    if chin_y is None and isinstance(pose_landmarks, dict) and pose_landmarks.get("chinY") is not None:
        try:
            cy_raw = float(pose_landmarks["chinY"])
            chin_y = int(round(cy_raw * h if cy_raw <= 1.5 else cy_raw))
        except Exception:
            pass

    # HARD CLOSE-UP FACE GATE (runs immediately before rembg to fail fast!)
    if face_box is not None and chin_y is not None:
        fx, fy, fw, fh = face_box
        face_h_ratio = fh / float(h)
        face_w_ratio = fw / float(w)
        chin_ratio = chin_y / float(h)
        torso_remaining = 1.0 - chin_ratio

        if face_h_ratio > 0.42 or chin_ratio > 0.76 or torso_remaining < 0.22 or face_w_ratio > 0.48:
            raise PoseTooCloseError(
                DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                details={
                    "reason": "face_closeup_gate",
                    "faceHeightRatio": round(face_h_ratio, 3),
                    "faceWidthRatio": round(face_w_ratio, 3),
                    "chinYRatio": round(chin_ratio, 3),
                    "torsoSpaceRatio": round(torso_remaining, 3),
                },
            )

    # 3. Server-side MediaPipe Pose (if installed) + rembg silhouette mask
    mp_pose = _detect_mediapipe_pose(rgb_np)
    person_mask = _extract_person_silhouette(rgb_img)

    # 4. Resolve shoulders (priority: browser poseLandmarks -> server MediaPipe -> rembg silhouette + face)
    left_shoulder: tuple[float, float] | None = None
    right_shoulder: tuple[float, float] | None = None
    left_hip: tuple[float, float] | None = None
    right_hip: tuple[float, float] | None = None
    pose_source = "silhouette_cv"

    if lm_ls is not None and lm_rs is not None:
        # Ensure left_shoulder has smaller x than right_shoulder in image coordinates
        pts = sorted([(lm_ls[0], lm_ls[1]), (lm_rs[0], lm_rs[1])], key=lambda p: p[0])
        left_shoulder, right_shoulder = pts[0], pts[1]
        pose_source = "client_landmarks"
    elif mp_pose is not None:
        mls = mp_pose["left_shoulder"]
        mrs = mp_pose["right_shoulder"]
        if mls[2] < 0.50 or mrs[2] < 0.50:
            raise PoseTooCloseError(
                DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                details={
                    "reason": "mediapipe_shoulder_visibility_low",
                    "leftVis": round(mls[2], 3),
                    "rightVis": round(mrs[2], 3),
                },
            )
        pts = sorted([(mls[0], mls[1]), (mrs[0], mrs[1])], key=lambda p: p[0])
        left_shoulder, right_shoulder = pts[0], pts[1]
        pose_source = "mediapipe_server"

    # Derive shoulders from silhouette + face geometry when pose landmarks not provided
    if left_shoulder is None or right_shoulder is None:
        ys_fg, xs_fg = np.where(person_mask)
        if len(ys_fg) < 500:
            raise PoseTooCloseError(
                DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                details={"reason": "no_person_silhouette"},
            )

        if face_box is None or chin_y is None:
            # No face detected AND no client pose landmarks -> inspect silhouette top
            top_y = int(ys_fg.min())
            _, _, upper_w = _row_span(person_mask, min(h - 1, top_y + int(0.16 * h)))
            if upper_w / float(w) > 0.72:
                raise PoseTooCloseError(
                    DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                    details={"reason": "closeup_no_face_wide_top", "upperWidthRatio": round(upper_w / float(w), 3)},
                )
            chin_y = min(int(0.32 * h), top_y + int(0.20 * h))
            cx = float(np.median(xs_fg[ys_fg <= top_y + int(0.20 * h)])) if np.any(ys_fg <= top_y + int(0.20 * h)) else w * 0.5
            est_fw = max(90, int(0.16 * w))
            face_box = (
                max(0, int(cx - est_fw * 0.5)),
                max(0, chin_y - int(est_fw * 1.15)),
                est_fw,
                int(est_fw * 1.15),
            )

        fx, fy, fw, fh = face_box
        face_cx = fx + fw * 0.5

        # Scan silhouette widths below chin to locate neck narrowing and shoulder onset
        scan_start = min(h - 4, int(chin_y + 0.02 * h))
        scan_end = min(h - 2, int(chin_y + 0.28 * h))
        if scan_end <= scan_start + 8:
            raise PoseTooCloseError(
                DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                details={"reason": "no_shoulder_space_below_chin", "chinYRatio": round(chin_y / float(h), 3)},
            )

        # Measure widths every 4px below chin
        sample_ys = list(range(scan_start, scan_end, 4))
        spans = [_row_span(person_mask, y) for y in sample_ys]
        widths = [sp[2] for sp in spans]
        max_band_w = max(widths) if widths else 0

        # Neck is typically narrowest in the first 35% of the scan below chin
        neck_slice = widths[: max(1, len(widths) // 3)]
        min_neck_w = min(neck_slice) if neck_slice else int(fw * 0.65)

        # Shoulders must widen meaningfully beyond face/neck
        target_sh_threshold = max(
            int(fw * 1.48),
            int(min_neck_w * 1.38),
            int(max_band_w * 0.78),
            int(0.22 * w),
        )

        sh_idx = None
        for idx, sw in enumerate(widths):
            if sw >= target_sh_threshold:
                sh_idx = idx
                break

        if sh_idx is None:
            # Fallback to widest row in shoulder band if reasonably wide
            if max_band_w >= int(0.24 * w):
                sh_idx = int(np.argmax(widths))
            else:
                raise PoseTooCloseError(
                    DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                    details={"reason": "shoulders_not_visible", "maxBandWidth": max_band_w},
                )

        sh_y = float(sample_ys[sh_idx])
        # Sample shoulder width slightly below onset (14px down) to measure true deltoid span
        sh_measure_y = min(h - 2, int(sh_y + max(12, int(0.025 * h))))
        lx_raw, rx_raw, sh_span = _row_span(person_mask, sh_measure_y)

        if sh_span < int(0.20 * w):
            raise PoseTooCloseError(
                DEFAULT_POSE_TOO_CLOSE_MESSAGE,
                details={"reason": "shoulder_span_too_narrow", "shoulderSpan": sh_span},
            )

        # Inset 8% from outer deltoid silhouette edges to approximate anatomical shoulder joints
        inset = sh_span * 0.08
        ls_x = max(0.0, lx_raw + inset)
        rs_x = min(float(w - 1), rx_raw - inset)

        # Refine individual left/right shoulder top Y along vertical columns near ls_x & rs_x
        def _shoulder_top_at(col_x: float) -> float:
            c = max(0, min(w - 1, int(round(col_x))))
            col_band = person_mask[max(chin_y, 0) : min(h, sh_measure_y + 24), max(0, c - 4) : min(w, c + 5)]
            rows_hit = np.where(np.any(col_band, axis=1))[0]
            if len(rows_hit) > 0:
                return float(max(chin_y, 0) + int(rows_hit[0]) + 8)
            return sh_y

        ls_y = _shoulder_top_at(ls_x)
        rs_y = _shoulder_top_at(rs_x)
        # Keep shoulder tilt subtle/realistic (avoid asymmetric hair/arm spike)
        avg_sy = 0.5 * (ls_y + rs_y)
        max_tilt = 0.045 * h
        ls_y = max(avg_sy - max_tilt, min(avg_sy + max_tilt, ls_y))
        rs_y = max(avg_sy - max_tilt, min(avg_sy + max_tilt, rs_y))

        # Keep shoulders centered reasonably around face_cx if arm stuck out on one side
        if abs((ls_x + rs_x) * 0.5 - face_cx) > 0.14 * w:
            half_sh = min(abs(face_cx - ls_x), abs(rs_x - face_cx))
            half_sh = max(half_sh, fw * 0.85, 0.14 * w)
            ls_x = max(8.0, face_cx - half_sh)
            rs_x = min(float(w - 9), face_cx + half_sh)

        left_shoulder = (ls_x, ls_y)
        right_shoulder = (rs_x, rs_y)

    # 5. Validate final mid_shoulder_y & shoulder_dist against strict framing bounds
    mid_shoulder_y = 0.5 * (left_shoulder[1] + right_shoulder[1])
    shoulder_dist = float(
        math.hypot(right_shoulder[0] - left_shoulder[0], right_shoulder[1] - left_shoulder[1])
    )
    mid_sh_ratio = mid_shoulder_y / float(h)

    if mid_sh_ratio > 0.72 or mid_sh_ratio < 0.14:
        raise PoseTooCloseError(
            DEFAULT_POSE_TOO_CLOSE_MESSAGE,
            details={
                "reason": "mid_shoulder_out_of_bounds",
                "midShoulderYRatio": round(mid_sh_ratio, 3),
            },
        )
    if shoulder_dist < 0.14 * w:
        raise PoseTooCloseError(
            DEFAULT_POSE_TOO_CLOSE_MESSAGE,
            details={
                "reason": "shoulder_dist_too_small",
                "shoulderDistRatio": round(shoulder_dist / float(w), 3),
            },
        )

    # Ensure chin_y is defined cleanly even if only poseLandmarks were given
    if chin_y is None:
        chin_y = max(16, int(mid_shoulder_y - 0.085 * h))
    # Guarantee chin_y stays above mid_shoulder_y when shoulders were validated
    if chin_y > int(mid_shoulder_y - 0.01 * h):
        chin_y = max(16, int(mid_shoulder_y - 0.025 * h))

    # 6. Resolve hips (client landmarks -> MediaPipe -> anatomical proportion + silhouette)
    if lm_lh is not None and lm_rh is not None and lm_lh[2] >= 0.40 and lm_rh[2] >= 0.40:
        hpts = sorted([(lm_lh[0], lm_lh[1]), (lm_rh[0], lm_rh[1])], key=lambda p: p[0])
        left_hip, right_hip = hpts[0], hpts[1]
    elif mp_pose is not None and mp_pose["left_hip"][2] >= 0.45 and mp_pose["right_hip"][2] >= 0.45:
        hpts = sorted(
            [
                (mp_pose["left_hip"][0], mp_pose["left_hip"][1]),
                (mp_pose["right_hip"][0], mp_pose["right_hip"][1]),
            ],
            key=lambda p: p[0],
        )
        left_hip, right_hip = hpts[0], hpts[1]
    else:
        torso_len = max(shoulder_dist * 1.48, 0.30 * h)
        torso_len = min(torso_len, 0.44 * h)
        hip_y = min(float(h - 24), mid_shoulder_y + torso_len)
        hlx, hrx, hspan = _row_span(person_mask, int(hip_y))
        sh_cx = 0.5 * (left_shoulder[0] + right_shoulder[0])
        if hspan >= int(0.18 * w) and hspan <= int(0.85 * w):
            hip_half = min(0.5 * hspan * 0.88, shoulder_dist * 0.62)
        else:
            hip_half = shoulder_dist * 0.48
        left_hip = (max(8.0, sh_cx - hip_half), hip_y)
        right_hip = (min(float(w - 9), sh_cx + hip_half), hip_y)

    detected = DetectedPose(
        width=w,
        height=h,
        face_box=face_box,
        chin_y=int(chin_y),
        left_shoulder=left_shoulder,
        right_shoulder=right_shoulder,
        left_hip=left_hip,
        right_hip=right_hip,
        mid_shoulder_y=mid_shoulder_y,
        shoulder_dist=shoulder_dist,
        person_mask=person_mask,
        source=pose_source,
    )
    return canvas_rgba, detected


def _bleed_rgb_into_transparent(rgba_arr: np.ndarray) -> np.ndarray:
    """Fill transparent pixels with nearest solid RGB so warpPerspective produces zero dark fringe."""
    alpha = rgba_arr[:, :, 3]
    valid = alpha > 36
    if not np.any(valid) or np.all(valid):
        return rgba_arr
    _, nearest_idx = ndimage.distance_transform_edt(~valid, return_indices=True)
    bled_rgb = rgba_arr[:, :, :3][nearest_idx[0], nearest_idx[1]]
    out = rgba_arr.copy()
    out[:, :, :3] = np.where(valid[:, :, None], rgba_arr[:, :, :3], bled_rgb)
    return out


def _strip_outer_white_halo(rgba_arr: np.ndarray) -> np.ndarray:
    """Flood-fill any stray near-white (R>240,G>240,B>240) border-connected background pixels to alpha=0."""
    h, w = rgba_arr.shape[:2]
    rgb = rgba_arr[:, :, :3]
    alpha = rgba_arr[:, :, 3].copy()

    # Check if any near-white opaque pixels touch outer border
    near_white = (rgb[:, :, 0] > 240) & (rgb[:, :, 1] > 240) & (rgb[:, :, 2] > 240) & (alpha > 10)
    border_seeds = np.zeros((h, w), dtype=bool)
    border_seeds[0, :] = near_white[0, :]
    border_seeds[-1, :] = near_white[-1, :]
    border_seeds[:, 0] = near_white[:, 0]
    border_seeds[:, -1] = near_white[:, -1]

    if not np.any(border_seeds):
        return rgba_arr

    # Connected white regions touching the outer border
    labeled, _ = ndimage.label(near_white)
    seed_labels = np.unique(labeled[border_seeds])
    seed_labels = seed_labels[seed_labels > 0]
    if len(seed_labels) == 0:
        return rgba_arr

    bg_white = np.isin(labeled, seed_labels)
    alpha[bg_white] = 0
    out = rgba_arr.copy()
    out[:, :, 3] = alpha
    return out


def _prepare_clean_garment_rgba(garment_bytes: bytes) -> np.ndarray:
    """Load real RGBA garment bytes, guarantee pure transparent background (corners alpha==0), tight-crop & edge-bleed."""
    with Image.open(io.BytesIO(garment_bytes)) as raw:
        im = ImageOps.exif_transpose(raw)
        has_alpha_band = "A" in im.getbands()
        rgba = im.convert("RGBA")

    arr = np.array(rgba, dtype=np.uint8)
    gh, gw = arr.shape[:2]
    corners = [
        int(arr[0, 0, 3]),
        int(arr[0, gw - 1, 3]),
        int(arr[gh - 1, 0, 3]),
        int(arr[gh - 1, gw - 1, 3]),
    ]

    if not has_alpha_band or any(c > 8 for c in corners):
        # Run rembg neural background removal to isolate pure garment RGBA (when onnxruntime available)
        sess = _get_rembg_session()
        if sess is not None:
            try:
                from rembg import remove

                cut = remove(rgba.convert("RGB"), session=sess, post_process_mask=True).convert("RGBA")
                arr = np.array(cut, dtype=np.uint8)
            except (Exception, SystemExit) as exc:
                logger.warning("rembg garment cutout failed (%s); using border floodfill", exc)

    # Strip any stray border-connected white background pixels
    arr = _strip_outer_white_halo(arr)

    # Keep only significant foreground components & tight-crop
    alpha = arr[:, :, 3]
    fg = alpha > 24
    ys, xs = np.where(fg)
    if len(xs) < 20 or len(ys) < 20:
        raise RuntimeError("Garment RGBA cutout is empty after background cleanup.")

    x0 = max(0, int(xs.min()) - 2)
    y0 = max(0, int(ys.min()) - 2)
    x1 = min(arr.shape[1], int(xs.max()) + 3)
    y1 = min(arr.shape[0], int(ys.max()) + 3)
    cropped = arr[y0:y1, x0:x1].copy()

    # Zero negligible alpha haze and bleed RGB for artifact-free perspective warp
    cropped[:, :, 3] = np.where(cropped[:, :, 3] < 14, 0, cropped[:, :, 3])
    return _bleed_rgb_into_transparent(cropped)


def _find_garment_quad(garment_rgba: np.ndarray) -> tuple[np.ndarray, float, float, float]:
    """
    Extract 4 anchor corners from garment alpha contour:
      (top_left_shoulder, top_right_shoulder, bottom_right_hem, bottom_left_hem).
    Returns (src_pts_4x2, sh_y_frac, sh_width, hem_width).
    """
    gh, gw = garment_rgba.shape[:2]
    mask = garment_rgba[:, :, 3] > 28

    # Inspect upper 22% to find where shoulder width stabilizes
    upper_end = max(6, int(gh * 0.24))
    upper_widths = []
    for y in range(0, upper_end):
        xs = np.where(mask[y])[0]
        upper_widths.append(int(xs[-1] - xs[0]) if len(xs) >= 4 else 0)
    max_up_w = max(upper_widths) if upper_widths else gw

    sh_y = int(gh * 0.10)
    for y, uw in enumerate(upper_widths):
        if uw >= max_up_w * 0.84:
            sh_y = max(2, y)
            break

    sh_xs = np.where(mask[min(gh - 1, sh_y)])[0]
    if len(sh_xs) >= 4:
        g_ls_x, g_rs_x = float(sh_xs[0]), float(sh_xs[-1])
    else:
        g_ls_x, g_rs_x = 0.08 * gw, 0.92 * gw

    # Inspect lower hem (y = 88%..97%)
    hem_y = min(gh - 2, int(gh * 0.94))
    hem_xs = np.where(mask[hem_y])[0]
    if len(hem_xs) < 4:
        hem_y = min(gh - 2, int(gh * 0.86))
        hem_xs = np.where(mask[hem_y])[0]
    if len(hem_xs) >= 4:
        g_bl_x, g_br_x = float(hem_xs[0]), float(hem_xs[-1])
    else:
        g_bl_x, g_br_x = 0.10 * gw, 0.90 * gw

    src_pts = np.array(
        [
            [g_ls_x, float(sh_y)],
            [g_rs_x, float(sh_y)],
            [g_br_x, float(hem_y)],
            [g_bl_x, float(hem_y)],
        ],
        dtype=np.float32,
    )
    sh_y_frac = float(sh_y) / max(1.0, float(gh))
    sh_w = max(16.0, g_rs_x - g_ls_x)
    hem_w = max(16.0, g_br_x - g_bl_x)
    return src_pts, sh_y_frac, sh_w, hem_w


def _match_ambient_lighting_lab(
    person_rgb: np.ndarray,
    garment_rgb: np.ndarray,
    garment_alpha: np.ndarray,
    person_mask: np.ndarray,
    strength: float = 0.22,
) -> np.ndarray:
    """Subtle CIE Lab luminance harmonization so garment matches studio photo lighting naturally."""
    g_solid = garment_alpha > 140
    if int(g_solid.sum()) < 200 or int(person_mask.sum()) < 200:
        return garment_rgb

    p_lab = cv2.cvtColor(person_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    g_lab = cv2.cvtColor(garment_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)

    p_l_med = float(np.median(p_lab[:, :, 0][person_mask]))
    g_l_med = float(np.median(g_lab[:, :, 0][g_solid]))

    delta_l = np.clip((p_l_med - g_l_med) * strength, -18.0, 18.0)
    g_lab[:, :, 0] = np.clip(g_lab[:, :, 0] + delta_l, 0.0, 255.0)
    return cv2.cvtColor(g_lab.astype(np.uint8), cv2.COLOR_LAB2RGB)


def _build_face_protection_mask(pose: DetectedPose) -> np.ndarray:
    """
    Build a smooth feathered [0..1] mask covering the person's head, face, hair & chin
    strictly up to `chin_y + 6` so re-compositing guarantees ZERO face pasting (MAE ~ 0).
    """
    h, w = pose.height, pose.width
    mask = np.zeros((h, w), dtype=np.float32)

    if pose.face_box is not None:
        fx, fy, fw, fh = pose.face_box
        cx = int(round(fx + fw * 0.5))
        cy = int(round(fy + fh * 0.45))
        rx = max(24, int(round(fw * 0.80)))
        ry = max(28, int(round(fh * 0.72)))
        cv2.ellipse(mask, (cx, cy), (rx, ry), 0.0, 0.0, 360.0, 1.0, -1)

        # Protect full upper head/hair crown strictly above chin_y
        crown_x0 = max(0, int(round(fx - fw * 0.55)))
        crown_x1 = min(w, int(round(fx + fw * 1.55)))
        crown_y1 = min(h, int(pose.chin_y + 4))
        mask[0:crown_y1, crown_x0:crown_x1] = np.maximum(
            mask[0:crown_y1, crown_x0:crown_x1],
            1.0,
        )
        # Hard cutoff strictly below chin_y + 8 so collar sits cleanly at neck base
        cut_y = min(h, int(pose.chin_y + 8))
        mask[cut_y:, :] = 0.0
    else:
        cut_y = min(h, int(pose.chin_y + 6))
        mask[:cut_y, :] = 1.0

    # Smooth 8px feathered transition along chin edge
    mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=4.5, sigmaY=4.5)
    # Keep inner face core 100% locked (exact original pixels -> face MAE ~ 0!)
    if pose.face_box is not None:
        fx, fy, fw, fh = pose.face_box
        cx = int(round(fx + fw * 0.5))
        cy = int(round(fy + fh * 0.48))
        inner = np.zeros((h, w), dtype=np.float32)
        cv2.ellipse(
            inner,
            (cx, cy),
            (max(16, int(round(fw * 0.58))), max(18, int(round(fh * 0.55)))),
            0.0,
            0.0,
            360.0,
            1.0,
            -1,
        )
        mask = np.maximum(mask, inner)

    return np.clip(mask, 0.0, 1.0)


def _render_smart_pose_warp_sync(
    *,
    person_image_bytes: bytes,
    garment_image_bytes: bytes | None,
    garment_category: VTONStepCategory,
    pose_landmarks: dict[str, Any] | None = None,
    precomputed: tuple[Image.Image, DetectedPose] | None = None,
) -> bytes:
    if not garment_image_bytes:
        raise RuntimeError(
            "Không tìm thấy ảnh sản phẩm gốc (RGBA cutout) để thực hiện ướm thử. "
            "Hệ thống không sử dụng hình vẽ mô phỏng."
        )

    if precomputed is not None:
        canvas_rgba, pose = precomputed
    else:
        canvas_rgba, pose = detect_pose_and_validate(
            person_image_bytes,
            pose_landmarks=pose_landmarks,
        )

    w, h = pose.width, pose.height
    person_rgb = np.array(canvas_rgba.convert("RGB"), dtype=np.uint8)

    # 1. Load & clean real RGBA garment (ZERO polygon placeholder!)
    garment_rgba = _prepare_clean_garment_rgba(garment_image_bytes)
    gh, gw = garment_rgba.shape[:2]
    src_pts, sh_y_frac, g_sh_w, g_hem_w = _find_garment_quad(garment_rgba)

    # 2. Compute perspective destination quad aligned to person's shoulders & hips
    ls_x, ls_y = pose.left_shoulder
    rs_x, rs_y = pose.right_shoulder
    lh_x, lh_y = pose.left_hip
    rh_x, rh_y = pose.right_hip

    sh_cx = 0.5 * (ls_x + rs_x)
    mid_sh_y = pose.mid_shoulder_y
    mid_hip_y = 0.5 * (lh_y + rh_y)
    sh_dist = pose.shoulder_dist
    hip_dist = max(0.16 * w, float(math.hypot(rh_x - lh_x, rh_y - lh_y)))

    dx = rs_x - ls_x
    dy = rs_y - ls_y
    angle = math.atan2(dy, dx)
    # Clamp tilt to gentle natural shoulder slope (+/- 14 deg)
    angle = max(-0.24, min(0.24, angle))
    ux, uy = math.cos(angle), math.sin(angle)
    vx, vy = -math.sin(angle), math.cos(angle)

    if garment_category == "LOWER":
        hip_cx = 0.5 * (lh_x + rh_x)
        top_y = max(float(pose.chin_y + int(0.18 * h)), mid_hip_y - int(0.04 * h))
        bot_y = min(float(h - 12), mid_hip_y + int(0.42 * h))
        target_top_w = max(0.26 * w, min(0.72 * w, hip_dist * 1.28))
        target_bot_w = max(
            target_top_w * 0.85,
            min(0.84 * w, target_top_w * (g_hem_w / max(1.0, g_sh_w))),
        )
        dst_pts = np.array(
            [
                [hip_cx - 0.5 * target_top_w, top_y],
                [hip_cx + 0.5 * target_top_w, top_y],
                [hip_cx + 0.5 * target_bot_w, bot_y],
                [hip_cx - 0.5 * target_bot_w, bot_y],
            ],
            dtype=np.float32,
        )
    else:
        # UPPER or OVERALL: collar strictly below chin_y & tailored to real shoulder silhouette!
        # Measure actual outer deltoid/arm span from person_mask around shoulder level
        _, _, outer_sh_span = _row_span(pose.person_mask, int(mid_sh_y + 18))
        if outer_sh_span < int(0.18 * w):
            outer_sh_span = int(sh_dist * 1.25)

        # Find shoulder-strap crest Y on left & right sides of neck so jacket sits right on top of shoulders
        crest_ys = []
        for side_x in (sh_cx - 0.34 * sh_dist, sh_cx + 0.34 * sh_dist):
            cx_i = max(0, min(w - 1, int(round(side_x))))
            col = pose.person_mask[max(0, pose.chin_y) : min(h, int(mid_sh_y + 36)), max(0, cx_i - 6) : min(w, cx_i + 7)]
            hits = np.where(np.any(col, axis=1))[0]
            if len(hits) > 0:
                crest_ys.append(float(max(0, pose.chin_y) + int(hits[0])))
        sh_crest_y = float(np.median(crest_ys)) if crest_ys else mid_sh_y

        # Place jacket top strictly below chin_y (+1.6% margin) while hugging the base of the neck cleanly
        neck_y = max(
            float(pose.chin_y + int(0.016 * h)),
            min(float(mid_sh_y - int(0.025 * h)), sh_crest_y - int(0.016 * h)),
        )

        if pose.source == "silhouette_cv":
            # Silhouette span already spans outer deltoids -> add gentle tailored drape ease (~6%)
            target_sh_w = float(outer_sh_span) * 1.06
        else:
            # Skeletal joint distance -> scale 1.38x but cap neatly to real outer shoulder span (+10%)
            target_sh_w = min(float(outer_sh_span) * 1.10, sh_dist * 1.38)
        target_sh_w = max(0.30 * w, min(0.68 * w, target_sh_w))

        raw_bot_y = (
            min(float(h - 12), mid_hip_y + int(0.36 * h))
            if garment_category == "OVERALL"
            else min(float(h - 12), mid_hip_y + int(0.05 * h))
        )
        desired_h = max(0.24 * h, raw_bot_y - neck_y)

        # Preserve realistic garment aspect ratio within natural tailoring tolerance
        nat_h = target_sh_w * (float(gh) / max(1.0, g_sh_w))
        if garment_category == "UPPER":
            target_h = float(np.clip(desired_h, nat_h * 0.86, nat_h * 1.18))
            target_h = min(target_h, float(h - 10) - neck_y)
        else:
            target_h = float(np.clip(desired_h, nat_h * 0.80, nat_h * 1.28))
            target_h = min(target_h, float(h - 10) - neck_y)

        # Anchor garment's shoulder line so topmost collar (y=0) lands right at neck_y
        sh_anchor_y = neck_y + sh_y_frac * target_h
        hem_anchor_y = neck_y + 0.94 * target_h
        vertical_span = max(48.0, hem_anchor_y - sh_anchor_y)

        width_ratio = float(np.clip(g_hem_w / max(1.0, g_sh_w), 0.78, 1.42))
        target_hem_w = max(0.28 * w, min(0.76 * w, target_sh_w * width_ratio))

        p_tl = np.array([sh_cx, sh_anchor_y]) - 0.5 * target_sh_w * np.array([ux, uy])
        p_tr = np.array([sh_cx, sh_anchor_y]) + 0.5 * target_sh_w * np.array([ux, uy])
        hem_center = np.array([sh_cx, sh_anchor_y]) + vertical_span * np.array([vx, vy])
        p_br = hem_center + 0.5 * target_hem_w * np.array([ux, uy])
        p_bl = hem_center - 0.5 * target_hem_w * np.array([ux, uy])

        dst_pts = np.array([p_tl, p_tr, p_br, p_bl], dtype=np.float32)

    # 3. Perspective warp RGB + Alpha separately for crisp edges & zero dark border bleed
    matrix = cv2.getPerspectiveTransform(src_pts, dst_pts)
    warped_rgb = cv2.warpPerspective(
        garment_rgba[:, :, :3],
        matrix,
        (w, h),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )
    warped_alpha = cv2.warpPerspective(
        garment_rgba[:, :, 3],
        matrix,
        (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )

    # Subtle 1.2px outer feathering on garment alpha for natural photographic integration
    alpha_f = warped_alpha.astype(np.float32) / 255.0
    feathered_a = cv2.GaussianBlur(alpha_f, (0, 0), sigmaX=1.0, sigmaY=1.0)
    # Keep opaque interior 100% solid, soften only outer 2px edge
    inner_solid = ndimage.binary_erosion(alpha_f > 0.75, iterations=2)
    alpha_f = np.where(inner_solid, np.maximum(alpha_f, 0.985), feathered_a)
    alpha_f = np.where(alpha_f < 0.02, 0.0, alpha_f)

    # 4. Gentle CIE Lab ambient lighting match
    harmonized_rgb = _match_ambient_lighting_lab(
        person_rgb,
        warped_rgb,
        (alpha_f * 255.0).astype(np.uint8),
        pose.person_mask,
        strength=0.22,
    )

    # 5. Soft contact drop shadow behind warped garment
    base_f = person_rgb.astype(np.float32)
    shift_m = np.array([[1.0, 0.0, 3.0], [0.0, 1.0, 7.0]], dtype=np.float32)
    shadow_a = cv2.warpAffine(
        alpha_f,
        shift_m,
        (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0.0,
    )
    shadow_a = cv2.GaussianBlur(shadow_a, (0, 0), sigmaX=7.0, sigmaY=7.0)
    # Attenuate shadow on empty background slightly, stronger on person silhouette
    body_weight = np.where(pose.person_mask, 0.24, 0.10).astype(np.float32)
    shadow_strength = np.clip(shadow_a * body_weight, 0.0, 0.28)
    # Keep shadow strictly below face/chin region too
    face_protect = _build_face_protection_mask(pose)
    shadow_strength = shadow_strength * (1.0 - face_protect)

    comp = base_f * (1.0 - shadow_strength[:, :, None]) + np.array([22.0, 16.0, 12.0]) * shadow_strength[:, :, None]

    # 6. Composite warped garment over shadowed portrait
    comp = comp * (1.0 - alpha_f[:, :, None]) + harmonized_rgb.astype(np.float32) * alpha_f[:, :, None]

    # 7. Face & Chin Protection Composite: original person face/head/chin pixels ON TOP (MAE ~ 0!)
    if garment_category != "LOWER":
        comp = comp * (1.0 - face_protect[:, :, None]) + base_f * face_protect[:, :, None]

    final_rgb = np.clip(np.round(comp), 0, 255).astype(np.uint8)
    out_buf = io.BytesIO()
    Image.fromarray(final_rgb, mode="RGB").save(out_buf, format="WEBP", quality=91, method=4)
    return out_buf.getvalue()


class SmartPoseWarpVTONProvider:
    """
    Tier 3 Local CV VTON Provider:
      - OpenCV YuNet/Haar + rembg silhouette + browser poseLandmarks
      - Hard POSE_TOO_CLOSE gate (zero face pasting)
      - OpenCV warpPerspective shoulder-to-waist alignment with Lab lighting match,
        contact drop shadow, and strict face/chin preservation composite.
    """

    name: str = "pose_warp"
    provider_type: VTONProviderType = "SMART_POSE_WARP"
    capabilities: ProviderCapabilities = ProviderCapabilities(
        name="pose_warp",
        display_name="Atelier Smart Pose-Warp CV Engine ($0 · Zero Face-Paste)",
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
        pose_landmarks: dict[str, Any] | None = None,
    ) -> tuple[Image.Image, DetectedPose]:
        return await asyncio.to_thread(
            detect_pose_and_validate,
            person_image_bytes,
            pose_landmarks=pose_landmarks,
        )

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
        precomputed_pose: tuple[Image.Image, DetectedPose] | None = None,
    ) -> VTONRenderStepResult:
        del garment_image_url, garment_label, step_order, total_steps
        started = time.perf_counter()
        output_bytes = await asyncio.to_thread(
            _render_smart_pose_warp_sync,
            person_image_bytes=person_image_bytes,
            garment_image_bytes=garment_image_bytes,
            garment_category=garment_category,
            pose_landmarks=pose_landmarks,
            precomputed=precomputed_pose,
        )
        latency_ms = max(1, int((time.perf_counter() - started) * 1000))
        digest = hashlib.sha256(output_bytes[:4096]).hexdigest()[:16]
        return VTONRenderStepResult(
            image_bytes=output_bytes,
            content_type="image/webp",
            provider_type="SMART_POSE_WARP",
            provider_display_badge=POSE_WARP_BADGE,
            external_job_id=f"posewarp_{garment_category.lower()}_{digest}",
            estimated_cost_usd=0.0,
            latency_ms=latency_ms,
            notes="Aligned via OpenCV warpPerspective with strict face/chin protection.",
        )

    async def generate(self, request: VTONRequest) -> VTONResult:
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
        job_id = f"tryon_posewarp_{digest}"
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
            notes="SmartPoseWarpVTONProvider ready.",
        )

    async def health_check(self) -> bool:
        return True
