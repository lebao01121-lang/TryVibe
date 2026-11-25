from __future__ import annotations

import io
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pytest
from PIL import Image

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app.cache_quota.quota import TryOnCacheQuota
from app.db.database import TryOnDatabase
from app.providers.base import (
    PHOTOMETRIC_INPAINT_BADGE,
    BaseVtonProvider,
    TryOnGenerationRequest,
    TryOnGenerationResult,
    VTONRequest,
    VTONResult,
)


def make_image_bytes(
    *,
    width: int = 768,
    height: int = 1024,
    mode: str = "RGB",
    color: tuple[int, ...] = (210, 195, 180),
    fmt: str = "PNG",
) -> bytes:
    img = Image.new(mode, (width, height), color)
    buf = io.BytesIO()
    if fmt.upper() == "WEBP":
        img.save(buf, format="WEBP", lossless=(mode == "RGBA"))
    elif fmt.upper() == "JPEG":
        img.convert("RGB").save(buf, format="JPEG", quality=90)
    else:
        img.save(buf, format="PNG")
    return buf.getvalue()


def make_synthetic_portrait_bytes(width: int = 768, height: int = 1024) -> bytes:
    """Create a realistic-proportioned standing person silhouette on light ivory studio backdrop."""
    arr = np.full((height, width, 3), (242, 239, 233), dtype=np.uint8)
    # Head (warm skin tone)
    cv2.ellipse(arr, (width // 2, int(height * 0.16)), (58, 72), 0, 0, 360, (218, 178, 152), -1)
    # Hair crown
    cv2.ellipse(arr, (width // 2, int(height * 0.11)), (62, 42), 0, 180, 360, (42, 34, 30), -1)
    # Neck
    cv2.rectangle(
        arr,
        (width // 2 - 26, int(height * 0.22)),
        (width // 2 + 26, int(height * 0.29)),
        (212, 172, 146),
        -1,
    )
    # Upper torso (dark navy top)
    pts_torso = np.array(
        [
            [int(width * 0.30), int(height * 0.30)],
            [int(width * 0.70), int(height * 0.30)],
            [int(width * 0.65), int(height * 0.64)],
            [int(width * 0.35), int(height * 0.64)],
        ],
        dtype=np.int32,
    )
    cv2.fillPoly(arr, [pts_torso], (48, 56, 74))
    # Arms (skin tone forearms)
    cv2.rectangle(
        arr,
        (int(width * 0.24), int(height * 0.31)),
        (int(width * 0.31), int(height * 0.68)),
        (214, 174, 148),
        -1,
    )
    cv2.rectangle(
        arr,
        (int(width * 0.69), int(height * 0.31)),
        (int(width * 0.76), int(height * 0.68)),
        (214, 174, 148),
        -1,
    )
    # Lower body (charcoal trousers)
    cv2.rectangle(
        arr,
        (int(width * 0.34), int(height * 0.64)),
        (int(width * 0.66), int(height * 0.98)),
        (60, 64, 72),
        -1,
    )
    buf = io.BytesIO()
    Image.fromarray(arr, mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def make_synthetic_garment_rgba_bytes(
    *,
    width: int = 768,
    height: int = 1024,
    rgb: tuple[int, int, int] = (232, 224, 210),
    with_dark_collar_cavity: bool = False,
    opaque_white_bg: bool = False,
) -> bytes:
    """Create a clean 3:4 garment flat-lay PNG (transparent or studio-white bg)."""
    if opaque_white_bg:
        arr = np.full((height, width, 4), (249, 249, 249, 255), dtype=np.uint8)
    else:
        arr = np.zeros((height, width, 4), dtype=np.uint8)

    # Bodice + sleeves polygon
    x0, x1 = int(width * 0.16), int(width * 0.84)
    y0, y1 = int(height * 0.10), int(height * 0.88)
    # Main torso
    arr[y0:y1, int(width * 0.26) : int(width * 0.74), :3] = rgb
    arr[y0:y1, int(width * 0.26) : int(width * 0.74), 3] = 255
    # Left & right sleeves
    arr[int(height * 0.14) : int(height * 0.62), x0 : int(width * 0.28), :3] = rgb
    arr[int(height * 0.14) : int(height * 0.62), x0 : int(width * 0.28), 3] = 255
    arr[int(height * 0.14) : int(height * 0.62), int(width * 0.72) : x1, :3] = rgb
    arr[int(height * 0.14) : int(height * 0.62), int(width * 0.72) : x1, 3] = 255

    # Subtle fabric shading gradient so folds have realistic variance
    ys = np.linspace(-12, 12, y1 - y0, dtype=np.float32)[:, None]
    bodice_slice = arr[y0:y1, int(width * 0.26) : int(width * 0.74), :3].astype(np.float32)
    arr[y0:y1, int(width * 0.26) : int(width * 0.74), :3] = np.clip(
        bodice_slice + ys[:, :, None], 0, 255
    ).astype(np.uint8)

    if with_dark_collar_cavity:
        # Dark mannequin cavity sitting at top-center neckline
        arr[y0 : y0 + 55, int(width * 0.42) : int(width * 0.58), :3] = (32, 32, 34)
        arr[y0 : y0 + 55, int(width * 0.42) : int(width * 0.58), 3] = 255

    buf = io.BytesIO()
    Image.fromarray(arr, mode="RGBA").save(buf, format="PNG")
    return buf.getvalue()


def make_synthetic_person_mask(width: int = 768, height: int = 1024) -> np.ndarray:
    mask = np.zeros((height, width), dtype=bool)
    # Head
    cv2.ellipse(mask.view(np.uint8), (width // 2, int(height * 0.16)), (58, 72), 0, 0, 360, 1, -1)
    # Neck
    mask[int(height * 0.22) : int(height * 0.29), width // 2 - 26 : width // 2 + 26] = True
    # Shoulders + torso + legs
    mask[int(height * 0.29) : int(height * 0.98), int(width * 0.28) : int(width * 0.72)] = True
    return mask


def make_valid_pose_landmarks() -> dict[str, Any]:
    return {
        "nose": {"x": 0.50, "y": 0.16, "visibility": 0.99},
        "leftShoulder": {"x": 0.34, "y": 0.32, "visibility": 0.96},
        "rightShoulder": {"x": 0.66, "y": 0.32, "visibility": 0.96},
        "leftElbow": {"x": 0.26, "y": 0.48, "visibility": 0.92},
        "rightElbow": {"x": 0.74, "y": 0.48, "visibility": 0.92},
        "leftWrist": {"x": 0.25, "y": 0.64, "visibility": 0.90},
        "rightWrist": {"x": 0.75, "y": 0.64, "visibility": 0.90},
        "leftHip": {"x": 0.38, "y": 0.64, "visibility": 0.94},
        "rightHip": {"x": 0.62, "y": 0.64, "visibility": 0.94},
        "chinY": 0.23,
        "faceBox": {"x": 0.42, "y": 0.09, "w": 0.16, "h": 0.14},
    }


def make_mediapipe_33_landmarks() -> list[dict[str, float]]:
    pts = [{"x": 0.5, "y": 0.5, "visibility": 0.0} for _ in range(33)]
    pts[0] = {"x": 0.50, "y": 0.16, "visibility": 0.99}   # nose
    pts[7] = {"x": 0.43, "y": 0.16, "visibility": 0.95}   # left ear
    pts[8] = {"x": 0.57, "y": 0.16, "visibility": 0.95}   # right ear
    pts[9] = {"x": 0.48, "y": 0.20, "visibility": 0.95}   # mouth left
    pts[10] = {"x": 0.52, "y": 0.20, "visibility": 0.95}  # mouth right
    pts[11] = {"x": 0.34, "y": 0.32, "visibility": 0.97}  # left shoulder
    pts[12] = {"x": 0.66, "y": 0.32, "visibility": 0.97}  # right shoulder
    pts[13] = {"x": 0.26, "y": 0.48, "visibility": 0.92}  # left elbow
    pts[14] = {"x": 0.74, "y": 0.48, "visibility": 0.92}  # right elbow
    pts[15] = {"x": 0.25, "y": 0.64, "visibility": 0.90}  # left wrist
    pts[16] = {"x": 0.75, "y": 0.64, "visibility": 0.90}  # right wrist
    pts[23] = {"x": 0.38, "y": 0.64, "visibility": 0.95}  # left hip
    pts[24] = {"x": 0.62, "y": 0.64, "visibility": 0.95}  # right hip
    return pts


class FakeMinioStorageClient:
    """In-memory MinIO substitute implementing the full async interface of MinioStorageClient."""

    def __init__(self) -> None:
        self.endpoint_url = "http://127.0.0.1:9000"
        self.private_bucket = "atelier-private-tryon"
        self.garments_bucket = "atelier-garments"
        self.public_bucket = "atelier-public"
        self.objects: dict[tuple[str, str], dict[str, Any]] = {}
        self.deleted_log: list[tuple[str, str]] = []

    def seed_object(
        self,
        key: str,
        data: bytes,
        *,
        bucket: str | None = None,
        content_type: str = "image/webp",
        last_modified: datetime | None = None,
    ) -> None:
        b = bucket or self.private_bucket
        self.objects[(b, key)] = {
            "data": data,
            "content_type": content_type,
            "last_modified": last_modified or datetime.now(timezone.utc),
        }

    async def ensure_buckets(self) -> bool:
        return True

    async def head_object(self, *, key: str, bucket: str | None = None) -> bool:
        return (bucket or self.private_bucket, key) in self.objects

    async def get_object_bytes(self, *, key: str, bucket: str | None = None) -> bytes | None:
        entry = self.objects.get((bucket or self.private_bucket, key))
        return entry["data"] if entry else None

    async def put_object_bytes(
        self,
        *,
        key: str,
        data: bytes,
        content_type: str = "image/webp",
        bucket: str | None = None,
    ) -> None:
        self.seed_object(key, data, bucket=bucket, content_type=content_type)

    async def delete_object(self, *, key: str, bucket: str | None = None) -> bool:
        b = bucket or self.private_bucket
        self.deleted_log.append((b, key))
        self.objects.pop((b, key), None)
        return True

    async def list_objects(
        self,
        *,
        bucket: str | None = None,
        prefix: str = "",
    ) -> list[dict[str, Any]]:
        b = bucket or self.private_bucket
        out: list[dict[str, Any]] = []
        for (obj_bucket, obj_key), meta in self.objects.items():
            if obj_bucket == b and obj_key.startswith(prefix):
                out.append(
                    {
                        "key": obj_key,
                        "size": len(meta["data"]),
                        "last_modified": meta["last_modified"],
                    }
                )
        return out

    async def generate_presigned_get_url(
        self,
        *,
        key: str,
        bucket: str | None = None,
        expires_in: int = 900,
    ) -> str:
        return f"http://127.0.0.1:9000/{bucket or self.private_bucket}/{key}?X-Amz-Expires={expires_in}"


class StubSuccessVtonProvider(BaseVtonProvider):
    """Fast deterministic provider returning valid 768x1024 WebP bytes."""

    name = "stub_success"
    provider_type = "PHOTOMETRIC_INPAINT"

    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[TryOnGenerationRequest] = []
        self._webp_bytes = make_image_bytes(width=768, height=1024, fmt="WEBP")

    async def synthesize(
        self,
        request: TryOnGenerationRequest,
        *,
        precomputed_pose: Any = None,
    ) -> TryOnGenerationResult:
        del precomputed_pose
        self.calls.append(request)
        if self.error is not None:
            raise self.error
        return TryOnGenerationResult(
            result_bytes=self._webp_bytes,
            content_type="image/webp",
            provider_used="photometric_inpaint",
            provider_type="PHOTOMETRIC_INPAINT",
            provider_badge=PHOTOMETRIC_INPAINT_BADGE,
            latency_ms=12,
            clean_collar_applied=True,
            external_job_id=f"stub_step_{request.step_order}",
            estimated_cost_usd=0.0,
            width=768,
            height=1024,
        )

    async def _generate_legacy_preview(self, request: VTONRequest) -> VTONResult:
        now = datetime.now(timezone.utc)
        return VTONResult(
            job_id=f"stub_{request.garment_sku_id}",
            provider=self.name,
            status="COMPLETED",
            result_bucket="atelier-private-tryon",
            result_object_key=f"previews/{request.user_id}/stub.webp",
            preview_url=f"minio://atelier-private-tryon/previews/{request.user_id}/stub.webp",
            aspect_ratio=request.aspect_ratio,
            latency_ms=5,
            created_at=now,
            expires_at=now,
        )


@pytest.fixture
async def isolated_db(tmp_path: Path) -> TryOnDatabase:
    """Isolated SQLite TryOnDatabase per test (no live PostgreSQL required)."""
    db = TryOnDatabase(
        database_url="sqlite:///tryon_db",
        sqlite_path=tmp_path / "tryon_test.sqlite",
        infra_mode="TEST",
    )
    await db.initialize()
    try:
        yield db
    finally:
        await db.close()


@pytest.fixture
def memory_cache_quota() -> TryOnCacheQuota:
    """TryOnCacheQuota configured to use deterministic in-memory fallback (no live Redis required)."""
    cq = TryOnCacheQuota(
        redis_url="redis://127.0.0.1:1/0",
        daily_limit=10,
        guest_ip_limit=5,
        auth_ip_limit=30,
        cache_ttl_seconds=900,
        is_production=True,
    )
    # Bypass network connection attempts in unit tests
    async def _no_redis() -> None:
        return None

    cq._get_redis = _no_redis  # type: ignore[method-assign]
    return cq


@pytest.fixture
def fake_minio() -> FakeMinioStorageClient:
    return FakeMinioStorageClient()
