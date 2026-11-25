from __future__ import annotations

import json
import struct
from datetime import timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from app.cache_quota.quota import TryOnCacheQuota
from app.db.database import TryOnDatabase
from app.db.models import TempUserImage, TryOnJob, TryOnSession, utcnow
from app.preprocessing.normalizer import (
    GarmentNormalizer,
    inspect_image_bytes,
    normalize_user_portrait_3x4,
    validate_magic_bytes,
)
from app.providers.base import PoseTooCloseError
from app.providers import photometric_inpaint_provider as pip_mod
from app.providers import smart_pose_warp_provider as spw_mod
from app.workers.consumer import TryOnQueuedTask, TryOnWorkerConsumer

from tests.conftest import (
    FakeMinioStorageClient,
    StubSuccessVtonProvider,
    make_image_bytes,
    make_mediapipe_33_landmarks,
    make_synthetic_person_mask,
    make_synthetic_portrait_bytes,
    make_valid_pose_landmarks,
)


# =============================================================================
# 1. Magic Bytes & Image Header Structural Validation
# =============================================================================


class TestMagicBytesValidation:
    def test_accepts_authentic_png_jpeg_webp(self) -> None:
        png_bytes = make_image_bytes(width=768, height=1024, mode="RGBA", fmt="PNG")
        jpg_bytes = make_image_bytes(width=640, height=960, mode="RGB", fmt="JPEG")
        webp_bytes = make_image_bytes(width=720, height=1080, mode="RGBA", fmt="WEBP")

        res_png = validate_magic_bytes(png_bytes)
        assert res_png.valid is True
        assert res_png.detected_mime == "image/png"
        assert res_png.extension == "png"
        assert (res_png.width, res_png.height) == (768, 1024)

        res_jpg = validate_magic_bytes(jpg_bytes)
        assert res_jpg.valid is True
        assert res_jpg.detected_mime == "image/jpeg"
        assert res_jpg.extension == "jpg"
        assert (res_jpg.width, res_jpg.height) == (640, 960)

        res_webp = validate_magic_bytes(webp_bytes)
        assert res_webp.valid is True
        assert res_webp.detected_mime == "image/webp"
        assert res_webp.extension == "webp"
        assert (res_webp.width, res_webp.height) == (720, 1080)

    @pytest.mark.parametrize(
        "forged_payload",
        [
            b"",
            b"short",
            b"<!DOCTYPE html><html><body><script>alert(1)</script></body></html>",
            b"\x7fELF\x02\x01\x01\x00" + b"\x00" * 64,  # Linux ELF binary spoofed as .jpg
            b"MZ\x90\x00\x03\x00\x00\x00" + b"\x00" * 64,  # Windows PE executable
            b"%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj",
            bytes(range(64)),  # arbitrary random bytes
            b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 48,  # spoofed JPEG header, corrupt body
            b"\x89PNG\r\n\x1a\n" + b"NOT_A_VALID_IHDR_CHUNK_BODY",  # spoofed PNG header
            b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 32,  # spoofed WebP header, corrupt body
        ],
    )
    def test_rejects_forged_and_corrupted_payloads(self, forged_payload: bytes) -> None:
        res = validate_magic_bytes(forged_payload)
        assert res.valid is False
        assert res.detected_mime is None
        assert res.extension is None
        assert res.error is not None and len(res.error) > 5

    def test_inspect_image_bytes_headers_and_garment_normalizer(self) -> None:
        png_rgba = make_image_bytes(width=768, height=1024, mode="RGBA", fmt="PNG")
        png_rgb = make_image_bytes(width=720, height=1080, mode="RGB", fmt="PNG")
        jpg = make_image_bytes(width=768, height=1024, mode="RGB", fmt="JPEG")
        webp_rgba = make_image_bytes(width=768, height=1024, mode="RGBA", fmt="WEBP")
        webp_lossy = make_image_bytes(width=720, height=1080, mode="RGB", fmt="WEBP")

        info_png = inspect_image_bytes(png_rgba)
        assert info_png.format == "PNG" and info_png.has_alpha is True and info_png.width == 768

        info_rgb = inspect_image_bytes(png_rgb)
        assert info_rgb.format == "PNG" and info_rgb.has_alpha is False

        info_jpg = inspect_image_bytes(jpg)
        assert info_jpg.format == "JPEG" and info_jpg.has_alpha is False and info_jpg.height == 1024

        info_webp = inspect_image_bytes(webp_rgba)
        assert info_webp.format == "WEBP" and info_webp.width == 768

        info_lossy = inspect_image_bytes(webp_lossy)
        assert info_lossy.format == "WEBP" and info_lossy.height == 1080

        # Synthetic VP8X header with alpha flag set
        vp8x = (
            b"RIFF"
            + struct.pack("<I", 22)
            + b"WEBPVP8X"
            + struct.pack("<I", 10)
            + bytes([0x10, 0, 0, 0])
            + (767).to_bytes(3, "little")
            + (1023).to_bytes(3, "little")
        )
        info_vp8x = inspect_image_bytes(vp8x)
        assert info_vp8x.format == "WEBP" and info_vp8x.has_alpha is True
        assert (info_vp8x.width, info_vp8x.height) == (768, 1024)

        assert inspect_image_bytes(b"unknown-binary-stream").format == "UNKNOWN"

        normalizer = GarmentNormalizer()
        ok = normalizer.validate_bytes(png_rgba, require_alpha=True)
        assert ok.valid is True and ok.matched_preset == "3:4"

        plan = normalizer.build_normalization_plan(ok)
        assert (plan.target_width, plan.target_height) == (768, 1024)
        assert plan.preserve_alpha is True

        # Reject opaque 16:9 image & too-small dimensions & non-positive dims
        bad_ratio = normalizer.validate_dimensions(1280, 720, has_alpha=False, require_alpha=True)
        assert bad_ratio.valid is False
        assert len(bad_ratio.errors) == 2

        small = normalizer.validate_dimensions(300, 400, has_alpha=True)
        assert small.valid is False

        zero = normalizer.validate_dimensions(0, 100, has_alpha=True)
        assert zero.valid is False

        unknown = normalizer.validate_bytes(b"not an image at all")
        assert unknown.valid is False

        portrait = normalize_user_portrait_3x4(jpg, target_size=(768, 1024))
        assert portrait.size == (768, 1024) and portrait.mode == "RGBA"


# =============================================================================
# 2. POSE_TOO_CLOSE Detection (Photometric & SmartPoseWarp)
# =============================================================================


class TestPoseTooCloseDetection:
    def test_closeup_face_box_raises_pose_too_close_photometric(self) -> None:
        portrait_bytes = make_synthetic_portrait_bytes()
        # Simulate close-up portrait where face occupies > 42% of height and chin is low
        closeup_face = (140, 160, 480, 520)  # face_h_ratio = 0.508 > 0.42
        with patch.object(
            pip_mod,
            "_detect_primary_face",
            return_value=(closeup_face, 710.0, (380.0, 420.0)),
        ):
            with pytest.raises(PoseTooCloseError) as exc_info:
                pip_mod.detect_anatomical_pose(portrait_bytes, strict_pose_gate=True)
        assert exc_info.value.code == "POSE_TOO_CLOSE"
        assert exc_info.value.details.get("reason") == "face_closeup_gate"

    def test_low_shoulder_visibility_raises_pose_too_close(self) -> None:
        portrait_bytes = make_synthetic_portrait_bytes()
        landmarks = make_valid_pose_landmarks()
        landmarks["leftShoulder"]["visibility"] = 0.22  # shoulders cropped off-frame
        with pytest.raises(PoseTooCloseError) as exc_info:
            pip_mod.detect_anatomical_pose(
                portrait_bytes,
                pose_landmarks=landmarks,
                strict_pose_gate=True,
            )
        assert exc_info.value.code == "POSE_TOO_CLOSE"
        assert "visibility" in str(exc_info.value.details.get("reason"))

    def test_upper_chest_portrait_with_shoulders_near_bottom_raises_pose_too_close(self) -> None:
        portrait_bytes = make_synthetic_portrait_bytes()
        landmarks = make_valid_pose_landmarks()
        # Shoulders pushed to y=0.82 (> 0.72 framing threshold) -> upper-chest/closeup crop
        landmarks["leftShoulder"]["y"] = 0.82
        landmarks["rightShoulder"]["y"] = 0.82
        with (
            patch.object(pip_mod, "_detect_primary_face", return_value=(None, None, None)),
            patch.object(
                pip_mod,
                "_extract_person_silhouette",
                return_value=make_synthetic_person_mask(),
            ),
        ):
            with pytest.raises(PoseTooCloseError) as exc_info:
                pip_mod.detect_anatomical_pose(
                    portrait_bytes,
                    pose_landmarks=landmarks,
                    strict_pose_gate=True,
                )
        assert exc_info.value.details.get("reason") == "mid_shoulder_out_of_bounds"

    def test_narrow_shoulder_span_and_empty_silhouette_raise_pose_too_close(self) -> None:
        portrait_bytes = make_synthetic_portrait_bytes()
        empty_mask = np.zeros((1024, 768), dtype=bool)
        with (
            patch.object(pip_mod, "_detect_primary_face", return_value=(None, None, None)),
            patch.object(pip_mod, "_extract_person_silhouette", return_value=empty_mask),
            patch.object(pip_mod, "_get_optional_mediapipe_pose", return_value=None),
        ):
            with pytest.raises(PoseTooCloseError) as exc_info:
                pip_mod.detect_anatomical_pose(portrait_bytes, strict_pose_gate=True)
        assert exc_info.value.details.get("reason") == "no_person_silhouette"

        # Wide top closeup with no face detected
        wide_top_mask = np.zeros((1024, 768), dtype=bool)
        wide_top_mask[10:900, 40:730] = True
        with (
            patch.object(pip_mod, "_detect_primary_face", return_value=(None, None, None)),
            patch.object(pip_mod, "_extract_person_silhouette", return_value=wide_top_mask),
            patch.object(pip_mod, "_get_optional_mediapipe_pose", return_value=None),
        ):
            with pytest.raises(PoseTooCloseError) as exc_info2:
                pip_mod.detect_anatomical_pose(portrait_bytes, strict_pose_gate=True)
        assert exc_info2.value.details.get("reason") == "closeup_no_face_wide_top"

    def test_valid_mediapipe_33_and_silhouette_cv_pass_pose_gate(self) -> None:
        portrait_bytes = make_synthetic_portrait_bytes()
        mask = make_synthetic_person_mask()
        with (
            patch.object(
                pip_mod,
                "_detect_primary_face",
                return_value=((320, 90, 128, 145), 240.0, (384.0, 165.0)),
            ),
            patch.object(pip_mod, "_extract_person_silhouette", return_value=mask),
            patch.object(pip_mod, "_get_optional_mediapipe_pose", return_value=None),
        ):
            # 1) With 33-point MediaPipe list
            canvas1, pose1 = pip_mod.detect_anatomical_pose(
                portrait_bytes,
                pose_landmarks=make_mediapipe_33_landmarks(),
                strict_pose_gate=True,
            )
            assert canvas1.size == (768, 1024)
            assert pose1.source == "client_landmarks"
            assert pose1.left_elbow is not None and pose1.right_wrist is not None

            # 2) Without landmarks -> silhouette CV fallback
            canvas2, pose2 = pip_mod.detect_anatomical_pose(
                portrait_bytes,
                pose_landmarks=None,
                strict_pose_gate=True,
            )
            assert canvas2.size == (768, 1024)
            assert pose2.source == "silhouette_cv"
            assert pose2.shoulder_dist >= 0.14 * 768

    def test_smart_pose_warp_closeup_gate(self) -> None:
        portrait_bytes = make_synthetic_portrait_bytes()
        landmarks = {"faceBox": {"x": 0.2, "y": 0.15, "w": 0.55, "h": 0.50}}
        with patch.object(spw_mod, "_detect_primary_face", return_value=(None, None)):
            with pytest.raises(PoseTooCloseError) as exc_info:
                spw_mod.detect_pose_and_validate(portrait_bytes, pose_landmarks=landmarks)
        assert exc_info.value.details.get("reason") == "face_closeup_gate"


# =============================================================================
# 3. Worker Catches PoseTooCloseError -> FAILED + Quota Refund (+1) + ZERO DLQ!
# =============================================================================


class TestWorkerPoseTooCloseRefundNoDlq:
    async def test_stage2_worker_catches_pose_too_close_refunds_quota_without_dlq(
        self,
        isolated_db: TryOnDatabase,
        memory_cache_quota: TryOnCacheQuota,
        fake_minio: FakeMinioStorageClient,
    ) -> None:
        user_id = "user-pose-refund-1"
        client_ip = "203.0.113.10"
        session_id = "sess-pose-too-close-s2"
        temp_img_id = "img-pose-s2"
        object_key = f"uploads/{temp_img_id}.png"
        portrait_bytes = make_synthetic_portrait_bytes()
        fake_minio.seed_object(object_key, portrait_bytes, content_type="image/png")

        now = utcnow()
        async with isolated_db.session() as db_sess:
            db_sess.add(
                TempUserImage(
                    id=temp_img_id,
                    user_id=user_id,
                    guest_session_id=None,
                    ip_address=client_ip,
                    source="STATIC_UPLOAD",
                    minio_object_key=object_key,
                    sha256_hash="a" * 64,
                    pose_score=0.9,
                    privacy_consent=True,
                    expires_at=now + timedelta(minutes=15),
                    is_purged=False,
                )
            )
            await db_sess.flush()
            db_sess.add(
                TryOnSession(
                    id=session_id,
                    user_id=user_id,
                    guest_session_id=None,
                    temp_image_id=temp_img_id,
                    mode="SINGLE",
                    upper_product_id="prod-silk-01",
                    status="QUEUED",
                    total_steps=1,
                    expires_at=now + timedelta(minutes=15),
                )
            )
            await db_sess.flush()
            db_sess.add(
                TryOnJob(
                    id="job-pose-s2-1",
                    session_id=session_id,
                    step_order=1,
                    product_id="prod-silk-01",
                    garment_category="UPPER",
                    cache_hash="b" * 64,
                    status="QUEUED",
                )
            )
            await db_sess.commit()

        # Pre-deduct 1 quota unit just as the API route does before enqueuing
        before_snap = await memory_cache_quota.get_dual_quota(
            user_id=user_id, ip_address=client_ip, loyalty_tier="BRONZE"
        )
        deducted_snap = await memory_cache_quota.deduct_dual_quota(
            user_id=user_id, ip_address=client_ip, loyalty_tier="BRONZE"
        )
        assert deducted_snap.remaining_quota == before_snap.remaining_quota - 1
        assert deducted_snap.used_today == 1

        failing_provider = StubSuccessVtonProvider(
            error=PoseTooCloseError("Ảnh chụp quá gần khuôn mặt — cần thấy rõ hai vai.")
        )
        worker = TryOnWorkerConsumer(
            rabbitmq_url="amqp://guest:guest@127.0.0.1:5672",
            provider=failing_provider,
            cache_quota=memory_cache_quota,
            db=isolated_db,
            minio=fake_minio,  # type: ignore[arg-type]
        )
        # Attach mock exchanges to prove ZERO messages are sent to retry or DLX/DLQ
        worker._direct_exchange = MagicMock()
        worker._direct_exchange.publish = AsyncMock()
        worker._dlx_exchange = MagicMock()
        worker._dlx_exchange.publish = AsyncMock()
        worker._emit_realtime_event = AsyncMock()  # type: ignore[method-assign]

        task = TryOnQueuedTask(
            session_id=session_id,
            temp_image_id=temp_img_id,
            object_key=object_key,
            cache_hash="b" * 64,
            mode="SINGLE",
            upper_product_id="prod-silk-01",
            upper_variant_id="var-ivory",
            lower_product_id=None,
            lower_variant_id=None,
            one_piece_product_id=None,
            one_piece_variant_id=None,
            user_id=user_id,
            guest_session_id=None,
            ip_address=client_ip,
            loyalty_tier="BRONZE",
            correlation_id="corr-pose-s2",
            is_stage2=True,
            cache_key="tryon:v2:" + "c" * 64,
            person_frame_sha256="a" * 64,
            lighting_preset="atelier",
            garments=(
                {
                    "slot": "upper",
                    "productId": "prod-silk-01",
                    "variantId": "var-ivory",
                    "name": "Áo Sơ Mi Lụa",
                },
            ),
        )

        # Deliver via RabbitMQ message handler (_on_rabbitmq_message)
        msg = MagicMock()
        msg.body = json.dumps(task.to_wire_envelope()).encode("utf-8")
        msg.headers = {"x-retry-attempt": 0}
        msg.ack = AsyncMock()
        msg.nack = AsyncMock()

        await worker._on_rabbitmq_message(msg)

        # 1) Message ACK'd cleanly — NEVER retried and NEVER sent to DLQ!
        msg.ack.assert_awaited_once()
        msg.nack.assert_not_awaited()
        worker._direct_exchange.publish.assert_not_awaited()
        worker._dlx_exchange.publish.assert_not_awaited()

        # 2) DB session marked FAILED with POSE_TOO_CLOSE + job marked FAILED
        async with isolated_db.session() as db_sess:
            sess_row = await db_sess.get(TryOnSession, session_id)
            job_row = await db_sess.get(TryOnJob, "job-pose-s2-1")
            assert sess_row is not None
            assert sess_row.status == "FAILED"
            assert sess_row.error_code == "POSE_TOO_CLOSE"
            assert job_row is not None and job_row.status == "FAILED"

        # 3) User + IP quota refunded (+1 back to original remaining)
        after_snap = await memory_cache_quota.get_dual_quota(
            user_id=user_id, ip_address=client_ip, loyalty_tier="BRONZE"
        )
        assert after_snap.used_today == 0
        assert after_snap.ip_used == 0
        assert after_snap.remaining_quota == before_snap.remaining_quota

        # 4) Job state in cache reflects quotaRefunded=True & POSE_TOO_CLOSE
        job_state = await memory_cache_quota.get_job_state(session_id)
        assert job_state is not None
        assert job_state["status"] == "FAILED"
        assert job_state["errorCode"] == "POSE_TOO_CLOSE"
        assert job_state["quotaRefunded"] is True

    async def test_legacy_worker_catches_pose_too_close_and_refunds_quota(
        self,
        isolated_db: TryOnDatabase,
        memory_cache_quota: TryOnCacheQuota,
        fake_minio: FakeMinioStorageClient,
    ) -> None:
        user_id = "user-pose-legacy"
        client_ip = "198.51.100.7"
        session_id = "sess-pose-legacy"
        temp_img_id = "img-pose-legacy"
        object_key = f"uploads/{temp_img_id}.png"
        fake_minio.seed_object(object_key, make_synthetic_portrait_bytes(), content_type="image/png")

        now = utcnow()
        async with isolated_db.session() as db_sess:
            db_sess.add(
                TempUserImage(
                    id=temp_img_id,
                    user_id=user_id,
                    guest_session_id=None,
                    ip_address=client_ip,
                    source="STATIC_UPLOAD",
                    minio_object_key=object_key,
                    sha256_hash="d" * 64,
                    pose_score=0.9,
                    privacy_consent=True,
                    expires_at=now + timedelta(minutes=15),
                )
            )
            await db_sess.flush()
            db_sess.add(
                TryOnSession(
                    id=session_id,
                    user_id=user_id,
                    guest_session_id=None,
                    temp_image_id=temp_img_id,
                    mode="SINGLE",
                    upper_product_id="prod-1",
                    status="QUEUED",
                    total_steps=1,
                )
            )
            await db_sess.flush()
            db_sess.add(
                TryOnJob(
                    id="job-pose-legacy-1",
                    session_id=session_id,
                    step_order=1,
                    product_id="prod-1",
                    garment_category="UPPER",
                    cache_hash="e" * 64,
                    status="QUEUED",
                )
            )
            await db_sess.commit()

        await memory_cache_quota.deduct_dual_quota(
            user_id=user_id, ip_address=client_ip, loyalty_tier="GOLD"
        )
        failing_provider = StubSuccessVtonProvider(error=PoseTooCloseError("Too close"))
        worker = TryOnWorkerConsumer(
            rabbitmq_url="amqp://guest:guest@127.0.0.1:5672",
            provider=failing_provider,
            cache_quota=memory_cache_quota,
            db=isolated_db,
            minio=fake_minio,  # type: ignore[arg-type]
        )
        worker._emit_realtime_event = AsyncMock()  # type: ignore[method-assign]
        worker._resolve_garment_image = AsyncMock(return_value=(b"fake", None, "shirt"))  # type: ignore[method-assign]

        task = TryOnQueuedTask(
            session_id=session_id,
            temp_image_id=temp_img_id,
            object_key=object_key,
            cache_hash="e" * 64,
            mode="SINGLE",
            upper_product_id="prod-1",
            upper_variant_id=None,
            lower_product_id=None,
            lower_variant_id=None,
            one_piece_product_id=None,
            one_piece_variant_id=None,
            user_id=user_id,
            guest_session_id=None,
            ip_address=client_ip,
            loyalty_tier="GOLD",
            correlation_id="corr-legacy-pose",
            is_stage2=False,
        )

        # Should NOT re-raise even with defer_failure_finalization=True, and should refund quota!
        await worker.execute_session(
            task,
            defer_failure_finalization=True,
            raise_on_transient_error=True,
        )

        async with isolated_db.session() as db_sess:
            sess_row = await db_sess.get(TryOnSession, session_id)
            assert sess_row is not None and sess_row.status == "FAILED"
            assert sess_row.error_code == "POSE_TOO_CLOSE"

        snap = await memory_cache_quota.get_dual_quota(
            user_id=user_id, ip_address=client_ip, loyalty_tier="GOLD"
        )
        assert snap.used_today == 0 and snap.remaining_quota == 15
