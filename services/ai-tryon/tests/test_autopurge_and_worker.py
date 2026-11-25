from __future__ import annotations

import asyncio
import base64
import json
from datetime import timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.cache_quota.quota import TryOnCacheQuota, compute_v2_step1_cache_key
from app.db.database import TryOnDatabase
from app.db.models import TempUserImage, TryOnJob, TryOnResult, TryOnSession, utcnow
from app.tasks.auto_purge import TryOnAutoPurgeTask
from app.workers.consumer import (
    RETRY_TIERS_MS,
    TRYON_DLQ,
    TRYON_DLX,
    TRYON_EXCHANGE,
    TRYON_QUEUE,
    RetryTopologySpec,
    TryOnQueuedTask,
    TryOnWorkerConsumer,
    _normalize_output_768x1024,
)

from tests.conftest import (
    FakeMinioStorageClient,
    StubSuccessVtonProvider,
    make_image_bytes,
    make_synthetic_garment_rgba_bytes,
    make_synthetic_portrait_bytes,
)


# =============================================================================
# 1. 15-Minute Hard Auto-Purge Task (`TryOnAutoPurgeTask`)
# =============================================================================


class TestTryOnAutoPurgeTask:
    async def test_purges_expired_over_15m_and_preserves_fresh_under_15m(
        self,
        isolated_db: TryOnDatabase,
        memory_cache_quota: TryOnCacheQuota,
        fake_minio: FakeMinioStorageClient,
    ) -> None:
        now = utcnow()
        expired_created = now - timedelta(minutes=25)
        expired_at = now - timedelta(minutes=10)
        fresh_created = now - timedelta(minutes=3)
        fresh_expires = now + timedelta(minutes=12)

        exp_upload_key = "uploads/expired-user-portrait.png"
        exp_result_key = "results/sess-expired.webp"
        exp_step1_key = "intermediate/sess-expired_step1.webp"
        orphan_old_key = "uploads/orphan-20m-old.png"
        fresh_upload_key = "uploads/fresh-user-portrait.png"
        fresh_result_key = "results/sess-fresh.webp"

        fake_minio.seed_object(exp_upload_key, b"expired-upload", last_modified=expired_created)
        fake_minio.seed_object(exp_result_key, b"expired-result", last_modified=expired_created)
        fake_minio.seed_object(exp_step1_key, b"expired-step1", last_modified=expired_created)
        fake_minio.seed_object(orphan_old_key, b"orphan-bytes", last_modified=expired_created)
        fake_minio.seed_object(fresh_upload_key, b"fresh-upload", last_modified=fresh_created)
        fake_minio.seed_object(fresh_result_key, b"fresh-result", last_modified=fresh_created)

        exp_cache_key = "tryon:v2:" + "1" * 64
        await memory_cache_quota.set_cached(exp_cache_key, {"resultObjectKey": exp_result_key})
        await memory_cache_quota.set_job_state("sess-expired", {"status": "COMPLETED"})

        async with isolated_db.session() as db_sess:
            # Expired (> 15 min) records
            db_sess.add(
                TempUserImage(
                    id="img-expired",
                    user_id="u-exp",
                    ip_address="10.0.0.1",
                    source="STATIC_UPLOAD",
                    minio_object_key=exp_upload_key,
                    sha256_hash="1" * 64,
                    pose_score=0.95,
                    privacy_consent=True,
                    expires_at=expired_at,
                    is_purged=False,
                    created_at=expired_created,
                )
            )
            await db_sess.flush()
            db_sess.add(
                TryOnSession(
                    id="sess-expired",
                    user_id="u-exp",
                    temp_image_id="img-expired",
                    mode="MIX_MATCH_OUTFIT",
                    status="COMPLETED",
                    cache_key=exp_cache_key,
                    expires_at=expired_at,
                    is_purged=False,
                    created_at=expired_created,
                )
            )
            await db_sess.flush()
            db_sess.add(
                TryOnJob(
                    id="job-expired",
                    session_id="sess-expired",
                    step_order=1,
                    product_id="p-exp",
                    garment_category="UPPER",
                    cache_hash="1" * 64,
                    status="COMPLETED",
                )
            )
            db_sess.add(
                TryOnResult(
                    id="res-expired",
                    session_id="sess-expired",
                    result_object_key=exp_result_key,
                    is_purged=False,
                    expires_at=expired_at,
                    created_at=expired_created,
                )
            )

            # Fresh (< 15 min) records — MUST NOT be purged!
            db_sess.add(
                TempUserImage(
                    id="img-fresh",
                    user_id="u-fresh",
                    ip_address="10.0.0.2",
                    source="STATIC_UPLOAD",
                    minio_object_key=fresh_upload_key,
                    sha256_hash="2" * 64,
                    pose_score=0.98,
                    privacy_consent=True,
                    expires_at=fresh_expires,
                    is_purged=False,
                    created_at=fresh_created,
                )
            )
            await db_sess.flush()
            db_sess.add(
                TryOnSession(
                    id="sess-fresh",
                    user_id="u-fresh",
                    temp_image_id="img-fresh",
                    mode="SINGLE",
                    status="COMPLETED",
                    cache_key="tryon:v2:" + "2" * 64,
                    expires_at=fresh_expires,
                    is_purged=False,
                    created_at=fresh_created,
                )
            )
            await db_sess.flush()
            db_sess.add(
                TryOnResult(
                    id="res-fresh",
                    session_id="sess-fresh",
                    result_object_key=fresh_result_key,
                    is_purged=False,
                    expires_at=fresh_expires,
                    created_at=fresh_created,
                )
            )
            await db_sess.commit()

        purger = TryOnAutoPurgeTask(
            db=isolated_db,
            minio=fake_minio,  # type: ignore[arg-type]
            cache_quota=memory_cache_quota,
            ttl_minutes=15,
            interval_seconds=60,
        )
        report = await purger.run_once()
        report_dict = report.as_dict()

        # Expired MinIO objects hard-deleted
        assert await fake_minio.head_object(key=exp_upload_key) is False
        assert await fake_minio.head_object(key=exp_result_key) is False
        assert await fake_minio.head_object(key=exp_step1_key) is False
        assert await fake_minio.head_object(key=orphan_old_key) is False
        assert exp_upload_key in report.deleted_keys
        assert exp_result_key in report.deleted_keys
        assert orphan_old_key in report.deleted_keys
        assert report_dict["purgedImages"] == 1
        assert report_dict["purgedResults"] == 1
        assert report_dict["purgedSessions"] >= 1
        assert report.purged_db_rows >= 3

        # Fresh (< 15 min) MinIO objects 100% UNTOUCHED
        assert await fake_minio.head_object(key=fresh_upload_key) is True
        assert await fake_minio.head_object(key=fresh_result_key) is True

        # Redis cache & job state cleared for expired session
        assert await memory_cache_quota.get_cached(exp_cache_key) is None
        assert await memory_cache_quota.get_job_state("sess-expired") is None

        # Verify DB flags: expired=purged, fresh=untouched
        async with isolated_db.session() as db_sess:
            exp_img = await db_sess.get(TempUserImage, "img-expired")
            exp_sess = await db_sess.get(TryOnSession, "sess-expired")
            exp_res = await db_sess.get(TryOnResult, "res-expired")
            fresh_img = await db_sess.get(TempUserImage, "img-fresh")
            fresh_sess = await db_sess.get(TryOnSession, "sess-fresh")
            fresh_res = await db_sess.get(TryOnResult, "res-fresh")

            assert exp_img is not None and exp_img.is_purged is True and exp_img.purged_at is not None
            assert exp_sess is not None and exp_sess.is_purged is True
            assert exp_res is not None and exp_res.is_purged is True

            assert fresh_img is not None and fresh_img.is_purged is False
            assert fresh_sess is not None and fresh_sess.is_purged is False
            assert fresh_res is not None and fresh_res.is_purged is False

        # Targeted single-session purge & test-backdate helper + background loop lifecycle
        backdate = await purger.expire_session_for_test(session_id="sess-fresh")
        assert backdate["expiredImages"] == 1 and backdate["expiredResults"] == 1
        targeted = await purger.run_once(session_id="sess-fresh")
        assert targeted.purged_sessions == 1
        assert await fake_minio.head_object(key=fresh_upload_key) is False

        purger.start()
        summary = purger.status_summary()
        assert summary["enabled"] is True and summary["ttlMinutes"] == 15
        await purger.stop()
        assert purger.status_summary()["enabled"] is False


# =============================================================================
# 2. Durable RabbitMQ Topology, Wire Serialization & Worker Consumer Paths
# =============================================================================


class TestRabbitMqTopologyAndWorker:
    def test_topology_spec_and_task_roundtrip_serialization(self) -> None:
        spec = RetryTopologySpec()
        d = spec.as_dict()
        assert d["exchange"] == TRYON_EXCHANGE == "atelier.tryon.direct"
        assert d["queue"] == TRYON_QUEUE == "tryon.jobs"
        assert d["routingKey"] == "tryon.jobs"
        assert d["prefetchCount"] == 2
        assert d["dlx"] == TRYON_DLX == "atelier.tryon.dlx"
        assert d["dlq"] == TRYON_DLQ == "atelier.tryon.dlq"
        assert d["retryQueues"] == [
            {"queue": "atelier.tryon.retry.1", "ttlMs": 2000},
            {"queue": "atelier.tryon.retry.2", "ttlMs": 10000},
            {"queue": "atelier.tryon.retry.3", "ttlMs": 30000},
        ]
        assert RETRY_TIERS_MS == (2_000, 10_000, 30_000)

        task = TryOnQueuedTask(
            session_id="sess-rt-1",
            temp_image_id="img-rt-1",
            object_key="uploads/img-rt-1.jpg",
            cache_hash="f" * 64,
            mode="MIX_MATCH_OUTFIT",
            upper_product_id="p-top",
            upper_variant_id="v-top",
            lower_product_id="p-bot",
            lower_variant_id="v-bot",
            one_piece_product_id=None,
            one_piece_variant_id=None,
            user_id="u-rt",
            guest_session_id=None,
            ip_address="10.1.2.3",
            loyalty_tier="DIAMOND",
            correlation_id="corr-rt-1",
            traceparent="00-" + "a" * 32 + "-" + "b" * 16 + "-01",
            simulate_failure=False,
            pose_landmarks={"nose": {"x": 0.5, "y": 0.16}},
            is_stage2=True,
            cache_key="tryon:v2:" + "9" * 64,
            person_frame_sha256="8" * 64,
            lighting_preset="evening",
            garments=(
                {"slot": "upper", "productId": "p-top", "variantId": "v-top"},
                {"slot": "lower", "productId": "p-bot", "variantId": "v-bot"},
            ),
            storefront_url="http://127.0.0.1:3000",
        )
        restored_dict = TryOnQueuedTask.from_dict(task.to_dict())
        assert restored_dict == task

        envelope = task.to_wire_envelope()
        assert envelope["eventName"] == "tryon.job.queued"
        assert envelope["jobId"] == "sess-rt-1"
        restored_wire = TryOnQueuedTask.from_wire_payload(envelope)
        assert restored_wire == task
        assert TryOnQueuedTask.from_wire_payload(task.to_dict()) == task

        # Output normalizer handles already-768x1024 fast path & resize for PNG/JPEG/WEBP
        raw_small = make_image_bytes(width=300, height=400, fmt="PNG")
        out_webp, ct_w = _normalize_output_768x1024(raw_small, "image/webp")
        out_png, ct_p = _normalize_output_768x1024(raw_small, "image/png")
        out_jpg, ct_j = _normalize_output_768x1024(raw_small, "image/jpeg")
        assert ct_w == "image/webp" and ct_p == "image/png" and ct_j == "image/jpeg"
        assert len(out_webp) > 100 and len(out_png) > 100 and len(out_jpg) > 100
        same_bytes, _ = _normalize_output_768x1024(out_webp, "image/webp")
        assert same_bytes == out_webp

    async def test_declare_topology_binds_retry_tiers_and_dlq(
        self, memory_cache_quota: TryOnCacheQuota
    ) -> None:
        worker = TryOnWorkerConsumer(
            rabbitmq_url="amqp://guest:guest@127.0.0.1:5672",
            provider=StubSuccessVtonProvider(),
            cache_quota=memory_cache_quota,
        )
        declared_exchanges: list[tuple[str, Any]] = []
        declared_queues: dict[str, dict[str, Any]] = {}
        bindings: list[tuple[str, str]] = []

        class FakeQueue:
            def __init__(self, name: str) -> None:
                self.name = name

            async def bind(self, exchange: Any, routing_key: str) -> None:
                bindings.append((self.name, routing_key))

        fake_channel = MagicMock()
        fake_channel.set_qos = AsyncMock()

        async def _decl_ex(name: str, ex_type: Any, durable: bool = True, **_kw: Any) -> Any:
            declared_exchanges.append((name, durable))
            return MagicMock(name=name)

        async def _decl_q(
            name: str, durable: bool = True, arguments: dict[str, Any] | None = None, **_kw: Any
        ) -> Any:
            declared_queues[name] = {"durable": durable, "arguments": arguments}
            return FakeQueue(name)

        fake_channel.declare_exchange = AsyncMock(side_effect=_decl_ex)
        fake_channel.declare_queue = AsyncMock(side_effect=_decl_q)

        main_q = await worker.declare_topology(fake_channel)
        assert main_q.name == "tryon.jobs"
        fake_channel.set_qos.assert_awaited_once_with(prefetch_count=2)

        assert set(declared_queues.keys()) == {
            "tryon.jobs",
            "atelier.tryon.retry.1",
            "atelier.tryon.retry.2",
            "atelier.tryon.retry.3",
            "atelier.tryon.dlq",
        }
        assert declared_queues["atelier.tryon.retry.1"]["arguments"]["x-message-ttl"] == 2000
        assert declared_queues["atelier.tryon.retry.2"]["arguments"]["x-message-ttl"] == 10000
        assert declared_queues["atelier.tryon.retry.3"]["arguments"]["x-message-ttl"] == 30000
        assert declared_queues["tryon.jobs"]["arguments"]["x-dead-letter-exchange"] == "atelier.tryon.dlx"
        assert declared_queues["tryon.jobs"]["arguments"]["x-dead-letter-routing-key"] == "atelier.tryon.dlq"
        assert ("atelier.tryon.dlq", "atelier.tryon.dlq") in bindings
        assert ("tryon.jobs", "tryon.jobs") in bindings

    async def test_stage2_outfit_pipeline_step1_cache_retry_dlq_and_cancel(
        self,
        isolated_db: TryOnDatabase,
        memory_cache_quota: TryOnCacheQuota,
        fake_minio: FakeMinioStorageClient,
    ) -> None:
        portrait_b = make_synthetic_portrait_bytes()
        garment_b = make_synthetic_garment_rgba_bytes()
        g_data_uri = "data:image/png;base64," + base64.b64encode(garment_b).decode("ascii")
        fake_minio.seed_object("uploads/p-ok.png", portrait_b, content_type="image/png")

        async def _seed_session(sid: str) -> None:
            now = utcnow()
            async with isolated_db.session() as db_sess:
                if await db_sess.get(TempUserImage, "img-ok") is None:
                    db_sess.add(
                        TempUserImage(
                            id="img-ok",
                            user_id="u-ok",
                            ip_address="10.0.0.10",
                            source="STATIC_UPLOAD",
                            minio_object_key="uploads/p-ok.png",
                            sha256_hash="5" * 64,
                            pose_score=0.99,
                            privacy_consent=True,
                            expires_at=now + timedelta(minutes=15),
                        )
                    )
                await db_sess.flush()
                db_sess.add(
                    TryOnSession(
                        id=sid,
                        user_id="u-ok",
                        temp_image_id="img-ok",
                        mode="MIX_MATCH_OUTFIT",
                        status="QUEUED",
                        total_steps=2,
                        expires_at=now + timedelta(minutes=15),
                    )
                )
                await db_sess.flush()
                for step in (1, 2):
                    db_sess.add(
                        TryOnJob(
                            id=f"job-{sid}-{step}",
                            session_id=sid,
                            step_order=step,
                            product_id=f"prod-{step}",
                            garment_category="UPPER" if step == 1 else "LOWER",
                            cache_hash="5" * 64,
                            status="QUEUED",
                        )
                    )
                await db_sess.commit()

        await _seed_session("sess-outfit-1")
        await _seed_session("sess-outfit-2")
        await _seed_session("sess-cancel")
        await _seed_session("sess-retry-dlq")

        provider = StubSuccessVtonProvider()
        worker = TryOnWorkerConsumer(
            rabbitmq_url="amqp://guest:guest@127.0.0.1:5672",
            provider=provider,
            cache_quota=memory_cache_quota,
            db=isolated_db,
            minio=fake_minio,  # type: ignore[arg-type]
        )
        worker._emit_realtime_event = AsyncMock()  # type: ignore[method-assign]

        top_g = {"slot": "upper", "productId": "prod-1", "variantId": "v1", "garmentImageUrl": g_data_uri}
        bot_g1 = {"slot": "lower", "productId": "prod-2", "variantId": "v2", "garmentImageUrl": g_data_uri}
        bot_g2 = {"slot": "lower", "productId": "prod-3", "variantId": "v3", "garmentImageUrl": g_data_uri}

        def _make_task(sid: str, garments: tuple[dict[str, Any], ...], sim_fail: bool = False) -> TryOnQueuedTask:
            return TryOnQueuedTask(
                session_id=sid,
                temp_image_id="img-ok",
                object_key="uploads/p-ok.png",
                cache_hash="5" * 64,
                mode="MIX_MATCH_OUTFIT",
                upper_product_id="prod-1",
                upper_variant_id="v1",
                lower_product_id="prod-2",
                lower_variant_id="v2",
                one_piece_product_id=None,
                one_piece_variant_id=None,
                user_id="u-ok",
                guest_session_id=None,
                ip_address="10.0.0.10",
                loyalty_tier="GOLD",
                correlation_id=f"corr-{sid}",
                simulate_failure=sim_fail,
                is_stage2=True,
                cache_key=f"tryon:v2:{sid}",
                person_frame_sha256="5" * 64,
                lighting_preset="atelier",
                garments=garments,
            )

        # 1) First 2-step OUTFIT run executes both steps & populates Step 1 intermediate cache
        await worker.execute_session(_make_task("sess-outfit-1", (top_g, bot_g1)))
        assert len(provider.calls) == 2
        assert await fake_minio.head_object(key="results/sess-outfit-1.webp") is True
        s1_key = compute_v2_step1_cache_key(
            person_frame_sha256="5" * 64, step1_garment=top_g, lighting_preset="atelier"
        )
        assert await memory_cache_quota.get_cached(s1_key) is not None

        # 2) Second OUTFIT run with SAME top + NEW bottom SKIPS Step 1 via cache (only 1 provider call!)
        await worker.execute_session(_make_task("sess-outfit-2", (top_g, bot_g2)))
        assert len(provider.calls) == 3  # only Step 2 called!
        async with isolated_db.session() as db_sess:
            s2_row = await db_sess.get(TryOnSession, "sess-outfit-2")
            assert s2_row is not None and s2_row.status == "COMPLETED"

        # 3) Cancelled job before execution -> CANCELLED + quota refund
        await memory_cache_quota.deduct_dual_quota(user_id="u-ok", ip_address="10.0.0.10", loyalty_tier="GOLD")
        await memory_cache_quota.mark_job_cancelled("sess-cancel")
        await worker.execute_session(_make_task("sess-cancel", (top_g,)))
        async with isolated_db.session() as db_sess:
            sc_row = await db_sess.get(TryOnSession, "sess-cancel")
            assert sc_row is not None and sc_row.status == "CANCELLED"

        # 4) Transient failure on attempt 0 routes to `atelier.tryon.retry.1`; fast_dlq routes directly to DLQ!
        worker._direct_exchange = MagicMock()
        worker._direct_exchange.publish = AsyncMock()
        worker._dlx_exchange = MagicMock()
        worker._dlx_exchange.publish = AsyncMock()
        worker.provider = StubSuccessVtonProvider(error=RuntimeError("upstream 502"))

        retry_task = _make_task("sess-retry-dlq", (top_g,))
        msg0 = MagicMock(
            body=json.dumps(retry_task.to_wire_envelope()).encode("utf-8"),
            headers={"x-retry-attempt": 0},
            ack=AsyncMock(),
            nack=AsyncMock(),
        )
        await worker._on_rabbitmq_message(msg0)
        msg0.ack.assert_awaited_once()
        worker._direct_exchange.publish.assert_awaited_once()
        assert worker._direct_exchange.publish.call_args.kwargs["routing_key"] == "atelier.tryon.retry.1"
        worker._dlx_exchange.publish.assert_not_awaited()

        # Attempt 3 (retries exhausted) -> marks FAILED, refunds quota, publishes to DLQ!
        msg3 = MagicMock(
            body=json.dumps(retry_task.to_wire_envelope()).encode("utf-8"),
            headers={"x-retry-attempt": 3},
            ack=AsyncMock(),
            nack=AsyncMock(),
        )
        await worker._on_rabbitmq_message(msg3)
        msg3.ack.assert_awaited_once()
        worker._dlx_exchange.publish.assert_awaited_once()
        assert worker._dlx_exchange.publish.call_args.kwargs["routing_key"] == "atelier.tryon.dlq"

        # Corrupt JSON & unrecognized payload -> nack(requeue=False)
        corrupt = MagicMock(body=b"{not-json", headers={}, ack=AsyncMock(), nack=AsyncMock())
        await worker._on_rabbitmq_message(corrupt)
        corrupt.nack.assert_awaited_once_with(requeue=False)

        unknown = MagicMock(body=b'{"foo": "bar"}', headers={}, ack=AsyncMock(), nack=AsyncMock())
        await worker._on_rabbitmq_message(unknown)
        unknown.nack.assert_awaited_once_with(requeue=False)

        # Legacy process_payload (cache miss -> cache hit) + helper methods
        worker.provider = StubSuccessVtonProvider()
        p_miss = await worker.process_payload(
            {
                "user_id": "u-p0",
                "garment_sku_id": "SKU-P0",
                "person_image_fingerprint": "fp-p0",
            }
        )
        p_hit = await worker.process_payload(
            {
                "user_id": "u-p0",
                "garment_sku_id": "SKU-P0",
                "person_image_fingerprint": "fp-p0",
            }
        )
        assert p_miss["cacheHit"] is False and p_hit["cacheHit"] is True
        assert worker._pick_best_garment_url({"primaryImageUrl": "http://a"}, {"tryonFlatUrl": "http://b"}) == "http://b"
        assert await worker._fetch_url_or_minio_bytes("minio://atelier-private-tryon/uploads/p-ok.png") == portrait_b

        # Legacy route_failure & fallback in-memory worker start/stop
        fake_ch = MagicMock()
        fake_ex = MagicMock(publish=AsyncMock())
        fake_ch.get_exchange = AsyncMock(return_value=fake_ex)
        assert await worker.route_failure(fake_ch, b"{}", {"x-retry-attempt": 1}, "err") == "atelier.tryon.retry.2"
        assert await worker.route_failure(fake_ch, b"{}", {"x-retry-attempt": 3}, "err") == "atelier.tryon.dlq"

        worker_fb = TryOnWorkerConsumer(
            rabbitmq_url="amqp://guest:guest@127.0.0.1:1",
            provider=StubSuccessVtonProvider(),
            cache_quota=memory_cache_quota,
        )
        await worker_fb.start()
        assert worker_fb.worker_transport == "in_memory_fallback"
        await worker_fb.stop()

    async def test_legacy_execute_session_and_handle_message_paths(
        self,
        isolated_db: TryOnDatabase,
        memory_cache_quota: TryOnCacheQuota,
        fake_minio: FakeMinioStorageClient,
    ) -> None:
        portrait_b = make_synthetic_portrait_bytes()
        garment_b = make_synthetic_garment_rgba_bytes()
        fake_minio.seed_object("uploads/leg.png", portrait_b, content_type="image/png")

        async def _seed_leg(sid: str, mode: str = "MIX_MATCH_OUTFIT") -> None:
            now = utcnow()
            async with isolated_db.session() as db_sess:
                if await db_sess.get(TempUserImage, "img-leg") is None:
                    db_sess.add(
                        TempUserImage(
                            id="img-leg",
                            user_id="u-leg",
                            ip_address="10.0.0.22",
                            source="STATIC_UPLOAD",
                            minio_object_key="uploads/leg.png",
                            sha256_hash="7" * 64,
                            pose_score=0.95,
                            privacy_consent=True,
                            expires_at=now + timedelta(minutes=15),
                        )
                    )
                    await db_sess.flush()
                db_sess.add(
                    TryOnSession(
                        id=sid,
                        user_id="u-leg",
                        temp_image_id="img-leg",
                        mode=mode,
                        status="QUEUED",
                        total_steps=2 if mode == "MIX_MATCH_OUTFIT" else 1,
                    )
                )
                await db_sess.flush()
                db_sess.add(
                    TryOnJob(
                        id=f"job-{sid}-1",
                        session_id=sid,
                        step_order=1,
                        product_id="p-top",
                        garment_category="UPPER",
                        cache_hash="7" * 64,
                        status="QUEUED",
                    )
                )
                if mode == "MIX_MATCH_OUTFIT":
                    db_sess.add(
                        TryOnJob(
                            id=f"job-{sid}-2",
                            session_id=sid,
                            step_order=2,
                            product_id="p-bot",
                            garment_category="LOWER",
                            cache_hash="7" * 64,
                            status="QUEUED",
                        )
                    )
                await db_sess.commit()

        await _seed_leg("sess-leg-mm", "MIX_MATCH_OUTFIT")
        await _seed_leg("sess-leg-simfail", "SINGLE")
        await _seed_leg("sess-leg-err", "SINGLE")

        worker = TryOnWorkerConsumer(
            rabbitmq_url="amqp://guest:guest@127.0.0.1:5672",
            provider=StubSuccessVtonProvider(),
            cache_quota=memory_cache_quota,
            db=isolated_db,
            minio=fake_minio,  # type: ignore[arg-type]
        )
        worker._emit_realtime_event = AsyncMock()  # type: ignore[method-assign]
        worker._resolve_garment_image = AsyncMock(return_value=(garment_b, None, "garment"))  # type: ignore[method-assign]

        def _leg_task(sid: str, mode: str = "MIX_MATCH_OUTFIT", sim_fail: bool = False) -> TryOnQueuedTask:
            return TryOnQueuedTask(
                session_id=sid,
                temp_image_id="img-leg",
                object_key="uploads/leg.png",
                cache_hash=f"hash-{sid}",
                mode=mode,
                upper_product_id="p-top",
                upper_variant_id=None,
                lower_product_id="p-bot" if mode == "MIX_MATCH_OUTFIT" else None,
                lower_variant_id=None,
                one_piece_product_id=None,
                one_piece_variant_id=None,
                user_id="u-leg",
                guest_session_id=None,
                ip_address="10.0.0.22",
                loyalty_tier="SILVER",
                correlation_id=f"corr-{sid}",
                simulate_failure=sim_fail,
                is_stage2=False,
            )

        # 1) Legacy MIX_MATCH_OUTFIT 2-step completion
        await worker.execute_session(_leg_task("sess-leg-mm", "MIX_MATCH_OUTFIT"))
        async with isolated_db.session() as db_sess:
            row = await db_sess.get(TryOnSession, "sess-leg-mm")
            assert row is not None and row.status == "COMPLETED"
        assert await fake_minio.head_object(key="results/sess-leg-mm.webp") is True

        # 2) Legacy simulate_failure triggers FAILED + quota refund
        await memory_cache_quota.deduct_dual_quota(user_id="u-leg", ip_address="10.0.0.22", loyalty_tier="SILVER")
        await worker.execute_session(_leg_task("sess-leg-simfail", "SINGLE", sim_fail=True))
        async with isolated_db.session() as db_sess:
            row_sf = await db_sess.get(TryOnSession, "sess-leg-simfail")
            assert row_sf is not None and row_sf.status == "FAILED"
            assert row_sf.error_code == "SIMULATED_FAILURE"

        # 3) Legacy provider error + handle_message routing
        worker.provider = StubSuccessVtonProvider(error=RuntimeError("boom"))
        await worker.execute_session(_leg_task("sess-leg-err", "SINGLE"))
        async with isolated_db.session() as db_sess:
            row_err = await db_sess.get(TryOnSession, "sess-leg-err")
            assert row_err is not None and row_err.status == "FAILED"
            assert row_err.error_code == "VTON_PROVIDER_ERROR"

        # 4) Legacy handle_message Phase 0 payload success & failure routing
        worker.provider = StubSuccessVtonProvider()
        fake_ch = MagicMock()
        fake_ex = MagicMock(publish=AsyncMock())
        fake_ch.get_exchange = AsyncMock(return_value=fake_ex)
        ok_msg = MagicMock(
            body=json.dumps({
                "user_id": "u-hm",
                "garment_sku_id": "SKU-HM",
                "person_image_fingerprint": "fp-hm",
            }).encode("utf-8"),
            headers={},
            ack=AsyncMock(),
        )
        await worker.handle_message(fake_ch, ok_msg)
        ok_msg.ack.assert_awaited_once()

        bad_msg = MagicMock(body=b'{"bad": 1}', headers={"x-retry-attempt": 0}, ack=AsyncMock())
        await worker.handle_message(fake_ch, bad_msg)
        bad_msg.ack.assert_awaited_once()
        fake_ex.publish.assert_awaited_once()

