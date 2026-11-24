from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from sqlalchemy import select

from app.cache_quota.quota import TryOnCacheQuota
from app.config import REPO_ROOT
from app.db.database import TryOnDatabase
from app.db.models import (
    TempUserImage,
    TryOnDemandEvent,
    TryOnJob,
    TryOnResult,
    TryOnSession,
    utcnow,
)
from app.providers.base import (
    PoseTooCloseError,
    VTONProvider,
    VTONRequest,
    VTONStepCategory,
    get_provider_display_badge,
)
from app.storage.minio_client import MinioStorageClient

try:
    import aio_pika
    from aio_pika import DeliveryMode, ExchangeType, Message
except ImportError:  # pragma: no cover - optional in bare environments
    aio_pika = None  # type: ignore[assignment]
    DeliveryMode = None  # type: ignore[assignment]
    ExchangeType = None  # type: ignore[assignment]
    Message = None  # type: ignore[assignment]

logger = logging.getLogger("atelier.ai_tryon.worker")

TRYON_EXCHANGE = "atelier.tryon.direct"
DOMAIN_TOPIC_EXCHANGE = "atelier.domain.topic"
TRYON_QUEUE = "atelier.tryon.jobs"
TRYON_ROUTING_KEY = "tryon.job.requested"
TRYON_DLX = "atelier.tryon.dlx"
TRYON_DLQ = "atelier.tryon.dlq"
TRYON_PREFETCH_COUNT = 2
RETRY_TIERS_MS: tuple[int, int, int] = (2_000, 10_000, 30_000)


@dataclass(frozen=True)
class RetryTopologySpec:
    exchange: str = TRYON_EXCHANGE
    domain_exchange: str = DOMAIN_TOPIC_EXCHANGE
    queue: str = TRYON_QUEUE
    routing_key: str = TRYON_ROUTING_KEY
    dlx: str = TRYON_DLX
    dlq: str = TRYON_DLQ
    prefetch_count: int = TRYON_PREFETCH_COUNT
    retry_tiers_ms: tuple[int, int, int] = RETRY_TIERS_MS

    def as_dict(self) -> dict[str, Any]:
        return {
            "exchange": self.exchange,
            "exchangeType": "direct",
            "domainExchange": self.domain_exchange,
            "queue": self.queue,
            "routingKey": self.routing_key,
            "prefetchCount": self.prefetch_count,
            "retryQueues": [
                {"queue": f"atelier.tryon.retry.{idx}", "ttlMs": ttl}
                for idx, ttl in enumerate(self.retry_tiers_ms, start=1)
            ],
            "dlx": self.dlx,
            "dlq": self.dlq,
        }


@dataclass(frozen=True)
class TryOnQueuedTask:
    session_id: str
    temp_image_id: str
    object_key: str
    cache_hash: str
    mode: str
    upper_product_id: str | None
    upper_variant_id: str | None
    lower_product_id: str | None
    lower_variant_id: str | None
    one_piece_product_id: str | None
    one_piece_variant_id: str | None
    user_id: str | None
    guest_session_id: str | None
    ip_address: str
    loyalty_tier: str | None
    correlation_id: str
    traceparent: str = ""
    simulate_failure: bool = False
    pose_landmarks: dict[str, Any] | None = None


class TryOnWorkerConsumer:
    """Async 1/2-step VTON worker with RabbitMQ + in-process queue, BFF Socket.io push & quota refund."""

    def __init__(
        self,
        *,
        rabbitmq_url: str,
        provider: VTONProvider,
        cache_quota: TryOnCacheQuota,
        db: TryOnDatabase | None = None,
        minio: MinioStorageClient | None = None,
        bff_url: str = "http://127.0.0.1:4000",
        catalog_url: str = "http://127.0.0.1:4002",
        internal_secret: str = "Atelier_Internal_Svc_2026!",
        purge_ttl_minutes: int = 15,
        presign_get_ttl_seconds: int = 900,
        prefetch_count: int = TRYON_PREFETCH_COUNT,
    ) -> None:
        self.rabbitmq_url = rabbitmq_url
        self.provider = provider
        self.cache_quota = cache_quota
        self.db = db
        self.minio = minio
        self.bff_url = bff_url.rstrip("/")
        self.catalog_url = catalog_url.rstrip("/")
        self.internal_secret = internal_secret
        self.purge_ttl_minutes = purge_ttl_minutes
        self.presign_get_ttl_seconds = presign_get_ttl_seconds
        self.topology = RetryTopologySpec(prefetch_count=prefetch_count)

        self._connection: Any | None = None
        self._queue: asyncio.Queue[TryOnQueuedTask] = asyncio.Queue()
        self._worker_tasks: list[asyncio.Task[None]] = []
        self._running = False
        self._catalog_image_cache: dict[str, str] = {}
        self._catalog_slug_by_id: dict[str, str] = {}
        self._catalog_cache_loaded_at: float = 0.0

    def start(self) -> None:
        """Start concurrent in-process worker tasks matching prefetch_count."""
        if self._running:
            return
        self._running = True
        self._worker_tasks = [
            asyncio.create_task(
                self._worker_loop(idx),
                name=f"tryon-worker-{idx}",
            )
            for idx in range(self.topology.prefetch_count)
        ]

    async def stop(self) -> None:
        self._running = False
        for task in self._worker_tasks:
            task.cancel()
        for task in self._worker_tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._worker_tasks.clear()

    async def enqueue(self, item: TryOnQueuedTask) -> None:
        """Publish to RabbitMQ (non-fatal) and enqueue directly for reliable processing."""
        asyncio.create_task(
            self._publish_rabbitmq_nonfatal(
                exchange_name=self.topology.exchange,
                exchange_type="direct",
                routing_key=self.topology.routing_key,
                payload={
                    "eventName": "tryon.job.queued",
                    "sessionId": item.session_id,
                    "mode": item.mode,
                    "cacheHash": item.cache_hash,
                    "correlationId": item.correlation_id,
                    "timestamp": utcnow().isoformat(),
                },
            )
        )
        await self._queue.put(item)

    async def _worker_loop(self, worker_index: int) -> None:
        while self._running:
            item = await self._queue.get()
            try:
                await self.execute_session(item)
            except Exception as exc:
                logger.exception(
                    "Worker %d unhandled error for session %s: %s",
                    worker_index,
                    item.session_id,
                    exc,
                )
            finally:
                self._queue.task_done()

    async def _publish_rabbitmq_nonfatal(
        self,
        *,
        exchange_name: str,
        exchange_type: str,
        routing_key: str,
        payload: dict[str, Any],
    ) -> None:
        if aio_pika is None or ExchangeType is None or Message is None:
            return
        try:
            conn = await asyncio.wait_for(
                aio_pika.connect(self.rabbitmq_url, timeout=0.6),
                timeout=0.8,
            )
            async with conn:
                channel = await conn.channel()
                ex_type = (
                    ExchangeType.TOPIC if exchange_type == "topic" else ExchangeType.DIRECT
                )
                exchange = await channel.declare_exchange(
                    exchange_name,
                    ex_type,
                    durable=True,
                )
                await exchange.publish(
                    Message(
                        body=json.dumps(payload).encode("utf-8"),
                        delivery_mode=DeliveryMode.PERSISTENT,
                        content_type="application/json",
                    ),
                    routing_key=routing_key,
                )
        except Exception:
            # Non-fatal when RabbitMQ container is offline in local Windows harness
            pass

    async def _emit_realtime_event(
        self,
        *,
        event_name: str,
        session_id: str,
        payload: dict[str, Any],
        correlation_id: str,
        traceparent: str = "",
    ) -> None:
        # 1. Push directly to BFF Socket.io internal broadcaster
        url = f"{self.bff_url}/internal/realtime/tryon-event"
        body = {
            "event": event_name,
            "sessionId": session_id,
            "payload": payload,
        }
        headers = {
            "x-internal-secret": self.internal_secret,
            "X-Correlation-Id": correlation_id,
            "Content-Type": "application/json",
        }
        if traceparent:
            headers["traceparent"] = traceparent
        try:
            async with httpx.AsyncClient(timeout=2.5) as client:
                await client.post(url, json=body, headers=headers)
        except Exception as exc:
            logger.debug(
                "BFF realtime broadcast skipped for %s (%s)",
                session_id,
                exc.__class__.__name__,
            )

        # 2. Mirror to RabbitMQ domain topic exchange (non-fatal)
        rmq_routing = event_name.replace(":", ".")
        asyncio.create_task(
            self._publish_rabbitmq_nonfatal(
                exchange_name=self.topology.domain_exchange,
                exchange_type="topic",
                routing_key=rmq_routing,
                payload={
                    "eventName": rmq_routing,
                    "sessionId": session_id,
                    "payload": payload,
                    "correlationId": correlation_id,
                    "timestamp": utcnow().isoformat(),
                },
            )
        )

    @staticmethod
    def _pick_best_garment_url(prod: dict[str, Any], var: dict[str, Any] | None = None) -> str:
        """Strictly prefer transparent RGBA 3:4 try-on flat-lay / 2:3 rack cutout URLs."""
        candidates: list[Any] = []
        if var is not None:
            candidates.extend(
                [
                    var.get("tryonFlatPreviewUrl"),
                    var.get("tryonFlatUrl"),
                    var.get("rackCutout2x3Url"),
                    var.get("rackFrontUrl"),
                    var.get("frontCutoutUrl"),
                    var.get("lookbookMainUrl"),
                ]
            )
        candidates.extend(
            [
                prod.get("tryonFlatAssetUrl"),
                prod.get("tryonFlatPreviewUrl"),
                prod.get("rackCutout2x3Url"),
                prod.get("rackFrontUrl"),
                prod.get("frontCutoutUrl"),
                prod.get("primaryImageUrl"),
            ]
        )
        for cand in candidates:
            if isinstance(cand, str) and cand.strip():
                return cand.strip()
        return ""

    async def _refresh_catalog_cache(self) -> None:
        now = time.monotonic()
        mapping: dict[str, str] = {}
        slug_map: dict[str, str] = {}
        endpoints = (
            f"{self.catalog_url}/v1/catalog/admin/products",
            f"{self.catalog_url}/v1/catalog/products",
        )
        async with httpx.AsyncClient(timeout=3.0) as client:
            for endpoint in endpoints:
                try:
                    resp = await client.get(endpoint, params={"pageSize": 100})
                    if resp.status_code != 200:
                        continue
                    raw = resp.json()
                    data = raw.get("data") if isinstance(raw, dict) else None
                    products = (
                        data.get("items", [])
                        if isinstance(data, dict)
                        else (data if isinstance(data, list) else [])
                    )
                    for prod in products:
                        if not isinstance(prod, dict):
                            continue
                        pid = str(prod.get("id") or prod.get("productId") or "").strip()
                        slug = str(prod.get("slug") or "").strip()
                        if pid and slug:
                            slug_map[pid] = slug

                        variants = prod.get("variants") or []
                        first_var = variants[0] if isinstance(variants, list) and variants and isinstance(variants[0], dict) else None
                        best_prod_url = self._pick_best_garment_url(prod, first_var)
                        if best_prod_url:
                            if pid and pid not in mapping:
                                mapping[pid] = best_prod_url
                            if slug and slug not in mapping:
                                mapping[slug] = best_prod_url

                        for var in variants if isinstance(variants, list) else []:
                            if not isinstance(var, dict):
                                continue
                            vid = str(var.get("id") or "").strip()
                            vurl = self._pick_best_garment_url(prod, var) or best_prod_url
                            if vid and vurl:
                                if pid and f"{pid}:{vid}" not in mapping:
                                    mapping[f"{pid}:{vid}"] = vurl
                                if slug and f"{slug}:{vid}" not in mapping:
                                    mapping[f"{slug}:{vid}"] = vurl
                except Exception:
                    continue

        if mapping:
            self._catalog_image_cache = mapping
            self._catalog_slug_by_id = slug_map
            self._catalog_cache_loaded_at = now

    async def _fetch_url_or_minio_bytes(self, image_url: str) -> bytes | None:
        if not image_url:
            return None

        # Handle minio://bucket/key directly
        if image_url.startswith("minio://") and self.minio is not None:
            parsed = urlparse(image_url)
            bucket = parsed.netloc
            key = parsed.path.lstrip("/")
            if bucket and key:
                try:
                    return await self.minio.get_object_bytes(bucket=bucket, key=key)
                except Exception:
                    pass

        # Normalize localhost -> 127.0.0.1 for reliable Windows loopback HTTP fetch
        fetch_url = image_url.replace("http://localhost:", "http://127.0.0.1:")
        if fetch_url.startswith("http://") or fetch_url.startswith("https://"):
            try:
                async with httpx.AsyncClient(timeout=4.5) as client:
                    r = await client.get(fetch_url)
                    if r.status_code == 200 and r.content and len(r.content) > 256:
                        return r.content
            except Exception:
                pass

            # Direct MinIO S3 fallback if URL points to known MinIO buckets
            if self.minio is not None:
                parsed = urlparse(fetch_url)
                parts = [p for p in parsed.path.lstrip("/").split("/") if p]
                if len(parts) >= 2 and parts[0] in (
                    self.minio.garments_bucket,
                    self.minio.public_bucket,
                    self.minio.private_bucket,
                ):
                    try:
                        return await self.minio.get_object_bytes(
                            bucket=parts[0],
                            key="/".join(parts[1:]),
                        )
                    except Exception:
                        pass
        return None

    def _load_real_manifest_fallback(self, product_id: str) -> tuple[bytes | None, str | None]:
        """Fallback to real processed RGBA flat-lay cutout from local real-assets-cache manifest."""
        slug = self._catalog_slug_by_id.get(product_id, product_id).strip()
        processed_dir = REPO_ROOT / "infra" / "seeds" / "real-assets-cache" / "processed"
        manifest_path = processed_dir / "manifest.json"
        if not manifest_path.exists():
            return None, None
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            products_map = manifest.get("products") or {}
            entry = products_map.get(slug)
            if not isinstance(entry, dict):
                return None, None
            rel = entry.get("tryonFlat") or entry.get("rackFront")
            if not rel:
                return None, None
            asset_path = processed_dir / str(rel)
            if asset_path.exists():
                return asset_path.read_bytes(), str(asset_path)
        except Exception:
            pass
        return None, None

    async def _resolve_garment_image(
        self,
        product_id: str | None,
        variant_id: str | None = None,
    ) -> tuple[bytes | None, str | None, str]:
        """Resolve real RGBA garment cutout from catalog-lookbook, MinIO, or real-assets manifest (NEVER polygon!)."""
        if not product_id:
            return None, None, ""

        now = time.monotonic()
        if now - self._catalog_cache_loaded_at > 90.0 or not self._catalog_image_cache:
            await self._refresh_catalog_cache()

        image_url = (
            self._catalog_image_cache.get(f"{product_id}:{variant_id}")
            if variant_id
            else None
        ) or self._catalog_image_cache.get(product_id)

        # If cache missed (e.g. newly seeded product), try refreshing once + direct product endpoint
        if not image_url:
            await self._refresh_catalog_cache()
            image_url = (
                self._catalog_image_cache.get(f"{product_id}:{variant_id}")
                if variant_id
                else None
            ) or self._catalog_image_cache.get(product_id)

        if not image_url:
            try:
                async with httpx.AsyncClient(timeout=2.5) as client:
                    resp = await client.get(f"{self.catalog_url}/v1/catalog/products/{product_id}")
                    if resp.status_code == 200:
                        raw = resp.json()
                        prod = raw.get("data") if isinstance(raw, dict) else raw
                        if isinstance(prod, dict):
                            slug = str(prod.get("slug") or "").strip()
                            if slug:
                                self._catalog_slug_by_id[product_id] = slug
                            matched_var = None
                            for v in prod.get("variants") or []:
                                if isinstance(v, dict) and variant_id and str(v.get("id") or "") == variant_id:
                                    matched_var = v
                                    break
                            if matched_var is None and prod.get("variants"):
                                first_v = prod["variants"][0]
                                if isinstance(first_v, dict):
                                    matched_var = first_v
                            image_url = self._pick_best_garment_url(prod, matched_var) or None
            except Exception:
                pass

        if image_url:
            fetched = await self._fetch_url_or_minio_bytes(image_url)
            if fetched:
                return fetched, image_url, self._catalog_slug_by_id.get(product_id, product_id)

        # Real processed RGBA flat-lay fallback from local real-assets-cache manifest
        manifest_bytes, manifest_path = self._load_real_manifest_fallback(product_id)
        if manifest_bytes:
            return manifest_bytes, image_url or manifest_path, self._catalog_slug_by_id.get(product_id, product_id)

        return None, image_url, product_id

    async def execute_session(self, task: TryOnQueuedTask) -> None:
        if self.db is None or self.minio is None:
            raise RuntimeError("Worker requires initialized TryOnDatabase and MinioStorageClient.")

        started = time.perf_counter()
        quota_snap = await self.cache_quota.get_dual_quota(
            user_id=task.user_id,
            ip_address=task.ip_address,
            loyalty_tier=task.loyalty_tier,
        )

        # Build step plan
        steps: list[tuple[int, VTONStepCategory, str | None, str | None, int, str]] = []
        if task.mode == "MIX_MATCH_OUTFIT":
            steps.append(
                (
                    1,
                    "UPPER",
                    task.upper_product_id or task.one_piece_product_id or "garment-upper",
                    task.upper_variant_id or task.one_piece_variant_id,
                    45,
                    "Bước 1/2: Đang ướm phom Áo (45%)",
                )
            )
            steps.append(
                (
                    2,
                    "LOWER",
                    task.lower_product_id or "garment-lower",
                    task.lower_variant_id,
                    85,
                    "Bước 2/2: Đang hoàn thiện Quần/Chân váy (85%)",
                )
            )
        else:
            if task.one_piece_product_id:
                cat: VTONStepCategory = "OVERALL"
                pid = task.one_piece_product_id
                vid = task.one_piece_variant_id
                msg = "Bước 1/1: Đang dựng phom Đầm nguyên bộ (60%)"
            elif task.lower_product_id and not task.upper_product_id:
                cat = "LOWER"
                pid = task.lower_product_id
                vid = task.lower_variant_id
                msg = "Bước 1/1: Đang dựng phom Quần/Chân váy (60%)"
            else:
                cat = "UPPER"
                pid = task.upper_product_id or "garment-upper"
                vid = task.upper_variant_id
                msg = "Bước 1/1: Đang dựng phom Áo (60%)"
            steps.append((1, cat, pid, vid, 60, msg))

        total_steps = len(steps)

        try:
            # 1. Fetch source user portrait from MinIO
            current_image_bytes = await self.minio.get_object_bytes(key=task.object_key)
            if not current_image_bytes:
                raise RuntimeError(
                    f"Source portrait object '{task.object_key}' not found in {self.minio.private_bucket}."
                )

            # 2. Handle dev/test simulated failure cleanly (after emitting step 1 start)
            if task.simulate_failure:
                await self._update_session_progress(
                    session_id=task.session_id,
                    status="PROCESSING_STEP_1",
                    progress_pct=25,
                    step_order=1,
                    step_message="Bước 1: Đang kết nối mô hình VTON...",
                )
                await self._emit_realtime_event(
                    event_name="tryon:progress",
                    session_id=task.session_id,
                    correlation_id=task.correlation_id,
                    traceparent=task.traceparent,
                    payload={
                        "sessionId": task.session_id,
                        "status": "PROCESSING_STEP_1",
                        "mode": task.mode,
                        "providerUsed": self.provider.provider_type,
                        "progressPct": 25,
                        "stepOrder": 1,
                        "totalSteps": total_steps,
                        "stepMessage": "Bước 1: Đang kết nối mô hình VTON...",
                        "remainingQuota": quota_snap.remaining_quota,
                    },
                )
                await asyncio.sleep(0.12)
                raise RuntimeError(
                    "Simulated VTON provider failure (simulateFailure=true) — automatic quota refund triggered."
                )

            # 3. Execute 1-step or 2-step sequential VTON compositing
            final_content_type = "image/webp"
            actual_provider_type = self.provider.provider_type
            actual_provider_badge = get_provider_display_badge(actual_provider_type)
            for step_order, category, prod_id, var_id, pct, step_msg in steps:
                status_label = (
                    "PROCESSING_STEP_1" if step_order == 1 else "PROCESSING_STEP_2"
                )
                await self._update_session_progress(
                    session_id=task.session_id,
                    status=status_label,
                    progress_pct=pct,
                    step_order=step_order,
                    step_message=step_msg,
                    job_status="PROCESSING",
                )
                await self._emit_realtime_event(
                    event_name="tryon:progress",
                    session_id=task.session_id,
                    correlation_id=task.correlation_id,
                    traceparent=task.traceparent,
                    payload={
                        "sessionId": task.session_id,
                        "status": status_label,
                        "mode": task.mode,
                        "providerUsed": actual_provider_type,
                        "providerDisplayBadge": actual_provider_badge,
                        "progressPct": pct,
                        "stepOrder": step_order,
                        "totalSteps": total_steps,
                        "stepMessage": step_msg,
                        "remainingQuota": quota_snap.remaining_quota,
                    },
                )

                garment_bytes, garment_url, garment_label = await self._resolve_garment_image(
                    prod_id, var_id
                )
                step_result = await self.provider.render_step(
                    person_image_bytes=current_image_bytes,
                    garment_image_bytes=garment_bytes,
                    garment_image_url=garment_url,
                    garment_category=category,
                    garment_label=garment_label,
                    step_order=step_order,
                    total_steps=total_steps,
                    pose_landmarks=task.pose_landmarks,
                )
                current_image_bytes = step_result.image_bytes
                final_content_type = step_result.content_type
                actual_provider_type = step_result.provider_type
                actual_provider_badge = (
                    step_result.provider_display_badge
                    or get_provider_display_badge(step_result.provider_type)
                )

                await self._mark_job_completed(
                    session_id=task.session_id,
                    step_order=step_order,
                    external_job_id=step_result.external_job_id,
                    estimated_cost_usd=step_result.estimated_cost_usd,
                    api_latency_ms=step_result.latency_ms,
                )

            # 4. Save final composited image into `atelier-private-tryon/results/{sessionId}.webp`
            ext = "png" if final_content_type == "image/png" else "webp"
            result_object_key = f"results/{task.session_id}.{ext}"
            await self.minio.put_object_bytes(
                key=result_object_key,
                data=current_image_bytes,
                content_type=final_content_type,
            )

            now = utcnow()
            expires_at = now + timedelta(minutes=self.purge_ttl_minutes)
            total_duration_ms = max(1, int((time.perf_counter() - started) * 1000))
            result_url = await self.minio.generate_presigned_get_url(
                key=result_object_key,
                expires_in=self.presign_get_ttl_seconds,
            )

            # 5. Persist TryOnResult, update TryOnSession=COMPLETED, log TRYON_COMPLETED demand signals
            async with self.db.session() as db_sess:
                sess_row = await db_sess.get(TryOnSession, task.session_id)
                if sess_row is not None:
                    sess_row.status = "COMPLETED"
                    sess_row.provider_used = actual_provider_type
                    sess_row.provider_display_badge = actual_provider_badge
                    sess_row.error_code = None
                    sess_row.error_message = None
                    sess_row.progress_pct = 100
                    sess_row.step_order = total_steps
                    sess_row.step_message = "Hoàn tất ướm thử AI — Ảnh tự động xóa sau 15 phút"
                    sess_row.total_duration_ms = total_duration_ms
                    sess_row.completed_at = now

                db_sess.add(
                    TryOnResult(
                        id=str(uuid4()),
                        session_id=task.session_id,
                        result_object_key=result_object_key,
                        is_purged=False,
                        satisfaction_rating=None,
                        expires_at=expires_at,
                        created_at=now,
                    )
                )

                product_ids = [
                    p
                    for p in (
                        task.upper_product_id,
                        task.lower_product_id,
                        task.one_piece_product_id,
                    )
                    if p
                ]
                for pid in dict.fromkeys(product_ids):
                    db_sess.add(
                        TryOnDemandEvent(
                            id=str(uuid4()),
                            product_id=pid,
                            sku_id=None,
                            session_id=task.session_id,
                            user_id=task.user_id,
                            signal_type="TRYON_COMPLETED",
                            created_at=now,
                        )
                    )
                await db_sess.commit()

            # 6. Save Redis SHA-256 Content-Hash Cache (TTL = 900s)
            await self.cache_quota.set_cached(
                task.cache_hash,
                {
                    "resultObjectKey": result_object_key,
                    "sessionId": task.session_id,
                    "mode": task.mode,
                    "providerUsed": actual_provider_type,
                    "providerDisplayBadge": actual_provider_badge,
                    "createdAt": now.isoformat(),
                    "expiresAt": expires_at.isoformat(),
                },
                ttl_seconds=self.presign_get_ttl_seconds,
            )

            # 7. Emit `tryon:completed` via Socket.io + RabbitMQ
            await self._emit_realtime_event(
                event_name="tryon:completed",
                session_id=task.session_id,
                correlation_id=task.correlation_id,
                traceparent=task.traceparent,
                payload={
                    "sessionId": task.session_id,
                    "status": "COMPLETED",
                    "mode": task.mode,
                    "providerUsed": actual_provider_type,
                    "providerDisplayBadge": actual_provider_badge,
                    "progressPct": 100,
                    "stepOrder": total_steps,
                    "totalSteps": total_steps,
                    "stepMessage": "Hoàn tất ướm thử AI — Ảnh tự động xóa sau 15 phút",
                    "resultUrl": result_url,
                    "errorCode": None,
                    "errorMessage": None,
                    "expiresAt": expires_at.isoformat(),
                    "purgeAt": expires_at.isoformat(),
                    "totalDurationMs": total_duration_ms,
                    "remainingQuota": quota_snap.remaining_quota,
                    "isPurged": False,
                },
            )

        except PoseTooCloseError as pose_exc:
            error_code = pose_exc.code or "POSE_TOO_CLOSE"
            error_msg = pose_exc.message
            total_duration_ms = max(1, int((time.perf_counter() - started) * 1000))
            now = utcnow()

            # Immediate +1 quota refund on POSE_TOO_CLOSE!
            refunded_snap = await self.cache_quota.refund_dual_quota(
                user_id=task.user_id,
                ip_address=task.ip_address,
                loyalty_tier=task.loyalty_tier,
            )
            default_badge = get_provider_display_badge(self.provider.provider_type)

            async with self.db.session() as db_sess:
                sess_row = await db_sess.get(TryOnSession, task.session_id)
                if sess_row is not None:
                    sess_row.status = "FAILED"
                    sess_row.error_code = error_code
                    sess_row.error_message = error_msg
                    sess_row.provider_display_badge = default_badge
                    sess_row.step_message = (
                        "Ảnh chụp quá gần khuôn mặt — Đã hoàn trả lại +1 lượt thử đồ AI"
                    )
                    sess_row.total_duration_ms = total_duration_ms
                    sess_row.completed_at = now

                jobs_res = await db_sess.execute(
                    select(TryOnJob).where(TryOnJob.session_id == task.session_id)
                )
                for job in jobs_res.scalars().all():
                    if job.status in ("QUEUED", "PROCESSING"):
                        job.status = "FAILED"
                await db_sess.commit()

            await self._emit_realtime_event(
                event_name="tryon:failed",
                session_id=task.session_id,
                correlation_id=task.correlation_id,
                traceparent=task.traceparent,
                payload={
                    "sessionId": task.session_id,
                    "status": "FAILED",
                    "mode": task.mode,
                    "providerUsed": self.provider.provider_type,
                    "providerDisplayBadge": default_badge,
                    "progressPct": 0,
                    "stepOrder": 0,
                    "totalSteps": total_steps,
                    "stepMessage": "Ảnh chụp quá gần khuôn mặt — Đã hoàn trả lại +1 lượt thử đồ AI",
                    "resultUrl": None,
                    "errorCode": error_code,
                    "message": error_msg,
                    "errorMessage": error_msg,
                    "totalDurationMs": total_duration_ms,
                    "remainingQuota": refunded_snap.remaining_quota,
                    "quotaRefunded": True,
                },
            )

        except Exception as exc:
            error_code = "SIMULATED_FAILURE" if task.simulate_failure else "VTON_PROVIDER_ERROR"
            error_msg = str(exc) or exc.__class__.__name__
            total_duration_ms = max(1, int((time.perf_counter() - started) * 1000))
            now = utcnow()

            # Automatic +1 quota refund on failure!
            refunded_snap = await self.cache_quota.refund_dual_quota(
                user_id=task.user_id,
                ip_address=task.ip_address,
                loyalty_tier=task.loyalty_tier,
            )
            default_badge = get_provider_display_badge(self.provider.provider_type)

            async with self.db.session() as db_sess:
                sess_row = await db_sess.get(TryOnSession, task.session_id)
                if sess_row is not None:
                    sess_row.status = "FAILED"
                    sess_row.error_code = error_code
                    sess_row.error_message = error_msg
                    sess_row.provider_display_badge = default_badge
                    sess_row.step_message = "Xử lý thất bại — Đã hoàn trả lại +1 lượt thử đồ AI"
                    sess_row.total_duration_ms = total_duration_ms
                    sess_row.completed_at = now

                jobs_res = await db_sess.execute(
                    select(TryOnJob).where(TryOnJob.session_id == task.session_id)
                )
                for job in jobs_res.scalars().all():
                    if job.status in ("QUEUED", "PROCESSING"):
                        job.status = "FAILED"
                await db_sess.commit()

            await self._emit_realtime_event(
                event_name="tryon:failed",
                session_id=task.session_id,
                correlation_id=task.correlation_id,
                traceparent=task.traceparent,
                payload={
                    "sessionId": task.session_id,
                    "status": "FAILED",
                    "mode": task.mode,
                    "providerUsed": self.provider.provider_type,
                    "providerDisplayBadge": default_badge,
                    "progressPct": 0,
                    "stepOrder": 0,
                    "totalSteps": total_steps,
                    "stepMessage": "Xử lý thất bại — Đã hoàn trả lại +1 lượt thử đồ AI",
                    "resultUrl": None,
                    "errorCode": error_code,
                    "message": error_msg,
                    "errorMessage": error_msg,
                    "totalDurationMs": total_duration_ms,
                    "remainingQuota": refunded_snap.remaining_quota,
                    "quotaRefunded": True,
                },
            )

    async def _update_session_progress(
        self,
        *,
        session_id: str,
        status: str,
        progress_pct: int,
        step_order: int,
        step_message: str,
        job_status: str | None = None,
    ) -> None:
        if self.db is None:
            return
        async with self.db.session() as db_sess:
            sess_row = await db_sess.get(TryOnSession, session_id)
            if sess_row is not None:
                sess_row.status = status
                sess_row.progress_pct = progress_pct
                sess_row.step_order = step_order
                sess_row.step_message = step_message
            if job_status is not None:
                job_res = await db_sess.execute(
                    select(TryOnJob).where(
                        TryOnJob.session_id == session_id,
                        TryOnJob.step_order == step_order,
                    )
                )
                job = job_res.scalar_one_or_none()
                if job is not None:
                    job.status = job_status
            await db_sess.commit()

    async def _mark_job_completed(
        self,
        *,
        session_id: str,
        step_order: int,
        external_job_id: str,
        estimated_cost_usd: float,
        api_latency_ms: int,
    ) -> None:
        if self.db is None:
            return
        async with self.db.session() as db_sess:
            job_res = await db_sess.execute(
                select(TryOnJob).where(
                    TryOnJob.session_id == session_id,
                    TryOnJob.step_order == step_order,
                )
            )
            job = job_res.scalar_one_or_none()
            if job is not None:
                job.status = "COMPLETED"
                job.external_job_id = external_job_id
                job.estimated_cost_usd = estimated_cost_usd
                job.api_latency_ms = api_latency_ms
            await db_sess.commit()

    # -------------------------------------------------------------------------
    # RabbitMQ topology & 3-tier retry -> DLQ consumer methods (Phase 0+4)
    # -------------------------------------------------------------------------

    async def declare_topology(self, channel: Any) -> Any:
        await channel.set_qos(prefetch_count=self.topology.prefetch_count)

        direct_exchange = await channel.declare_exchange(
            self.topology.exchange,
            ExchangeType.DIRECT,
            durable=True,
        )
        dlx_exchange = await channel.declare_exchange(
            self.topology.dlx,
            ExchangeType.DIRECT,
            durable=True,
        )

        dlq = await channel.declare_queue(self.topology.dlq, durable=True)
        await dlq.bind(dlx_exchange, routing_key=self.topology.dlq)

        main_queue = await channel.declare_queue(
            self.topology.queue,
            durable=True,
            arguments={
                "x-dead-letter-exchange": self.topology.dlx,
                "x-dead-letter-routing-key": self.topology.dlq,
            },
        )
        await main_queue.bind(direct_exchange, routing_key=self.topology.routing_key)

        for idx, ttl_ms in enumerate(self.topology.retry_tiers_ms, start=1):
            retry_queue_name = f"atelier.tryon.retry.{idx}"
            retry_queue = await channel.declare_queue(
                retry_queue_name,
                durable=True,
                arguments={
                    "x-message-ttl": ttl_ms,
                    "x-dead-letter-exchange": self.topology.exchange,
                    "x-dead-letter-routing-key": self.topology.routing_key,
                },
            )
            await retry_queue.bind(direct_exchange, routing_key=retry_queue_name)

        return main_queue

    async def process_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        request = VTONRequest(
            user_id=str(payload["user_id"]),
            garment_sku_id=str(payload["garment_sku_id"]),
            garment_image_url=str(payload.get("garment_image_url", "")),
            person_image_fingerprint=str(payload["person_image_fingerprint"]),
            garment_category=payload.get("garment_category", "TOP"),
            aspect_ratio=payload.get("aspect_ratio", "2:3"),
            correlation_id=str(payload.get("correlation_id", "")),
        )
        cache_key = self.cache_quota.compute_cache_key(
            person_fingerprint=request.person_image_fingerprint,
            garment_sku_id=request.garment_sku_id,
            garment_category=request.garment_category,
            provider=self.provider.name,
            aspect_ratio=request.aspect_ratio,
        )
        cached = await self.cache_quota.get_cached(cache_key)
        if cached is not None:
            return {"cacheHit": True, "cacheKey": cache_key, "result": cached}

        result = await self.provider.generate(request)
        serialized = {
            "jobId": result.job_id,
            "provider": result.provider,
            "status": result.status,
            "resultBucket": result.result_bucket,
            "resultObjectKey": result.result_object_key,
            "previewUrl": result.preview_url,
            "expiresAt": result.expires_at.isoformat(),
        }
        await self.cache_quota.set_cached(cache_key, serialized)
        return {"cacheHit": False, "cacheKey": cache_key, "result": serialized}

    async def route_failure(
        self,
        channel: Any,
        body: bytes,
        headers: dict[str, Any],
        error_reason: str,
    ) -> str:
        retry_count = int(headers.get("x-retry-count", 0))
        next_headers = {**headers, "x-last-error": error_reason}

        if retry_count < len(self.topology.retry_tiers_ms):
            tier = retry_count + 1
            next_headers["x-retry-count"] = tier
            retry_routing_key = f"atelier.tryon.retry.{tier}"
            exchange = await channel.get_exchange(self.topology.exchange)
            await exchange.publish(
                Message(
                    body=body,
                    delivery_mode=DeliveryMode.PERSISTENT,
                    content_type="application/json",
                    headers=next_headers,
                ),
                routing_key=retry_routing_key,
            )
            return retry_routing_key

        dlx = await channel.get_exchange(self.topology.dlx)
        next_headers["x-dead-lettered"] = True
        await dlx.publish(
            Message(
                body=body,
                delivery_mode=DeliveryMode.PERSISTENT,
                content_type="application/json",
                headers=next_headers,
            ),
            routing_key=self.topology.dlq,
        )
        return self.topology.dlq

    async def handle_message(self, channel: Any, message: Any) -> None:
        try:
            payload = json.loads(message.body.decode("utf-8"))
            await self.process_payload(payload)
            await message.ack()
        except Exception as exc:
            headers = dict(message.headers or {})
            destination = await self.route_failure(
                channel=channel,
                body=message.body,
                headers=headers,
                error_reason=str(exc),
            )
            logger.warning("Try-on message failed (%s); routed to %s", exc, destination)
            await message.ack()
