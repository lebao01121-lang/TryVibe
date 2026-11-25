from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import time
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from PIL import Image, ImageOps
from sqlalchemy import select

from app.cache_quota.quota import (
    TryOnCacheQuota,
    compute_v2_step1_cache_key,
    normalize_garment_slot,
    sort_garments_physically,
)
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
    TryOnGenerationRequest,
    VTONProvider,
    VTONRequest,
    VTONStepCategory,
    get_provider_display_badge,
    normalize_cloth_type,
)
from app.storage.minio_client import MinioStorageClient

try:
    import aio_pika
    from aio_pika import DeliveryMode, ExchangeType, Message
    from aio_pika.exceptions import ChannelPreconditionFailed
except ImportError:  # pragma: no cover - optional in bare environments
    aio_pika = None  # type: ignore[assignment]
    DeliveryMode = None  # type: ignore[assignment]
    ExchangeType = None  # type: ignore[assignment]
    Message = None  # type: ignore[assignment]
    ChannelPreconditionFailed = Exception  # type: ignore[assignment,misc]

WorkerTransport = Literal["rabbitmq", "in_memory_fallback"]

logger = logging.getLogger("atelier.ai_tryon.worker")

TRYON_EXCHANGE = "atelier.tryon.direct"
DOMAIN_TOPIC_EXCHANGE = "atelier.domain.topic"
TRYON_QUEUE = "tryon.jobs"
TRYON_LEGACY_QUEUE = "atelier.tryon.jobs"
TRYON_ROUTING_KEY = "tryon.jobs"
TRYON_DLX = "atelier.tryon.dlx"
TRYON_DLQ = "atelier.tryon.dlq"
TRYON_PREFETCH_COUNT = 2
RETRY_TIERS_MS: tuple[int, int, int] = (2_000, 10_000, 30_000)


def _normalize_output_768x1024(image_bytes: bytes, content_type: str = "image/webp") -> tuple[bytes, str]:
    """Ensure final synthesized output image has exact 768x1024 dimensions without unnecessary recompression."""
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            if img.size == (768, 1024):
                return image_bytes, content_type
            transposed = ImageOps.exif_transpose(img)
            rgb = transposed.convert("RGB")
            fitted = ImageOps.fit(
                rgb,
                (768, 1024),
                method=Image.Resampling.LANCZOS,
                centering=(0.5, 0.35),
            )
            buf = io.BytesIO()
            if content_type == "image/png":
                fitted.save(buf, format="PNG")
                return buf.getvalue(), "image/png"
            if content_type == "image/jpeg":
                fitted.save(buf, format="JPEG", quality=92)
                return buf.getvalue(), "image/jpeg"
            fitted.save(buf, format="WEBP", quality=90)
            return buf.getvalue(), "image/webp"
    except Exception:
        return image_bytes, content_type


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
    pose_landmarks: dict[str, Any] | list[dict[str, Any]] | None = None
    # Stage 2 async multi-step fields (fully backwards-compatible defaults)
    is_stage2: bool = False
    cache_key: str = ""
    person_frame_sha256: str = ""
    lighting_preset: str = "atelier"
    garments: tuple[dict[str, Any], ...] = ()
    storefront_url: str = "http://127.0.0.1:3000"

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "temp_image_id": self.temp_image_id,
            "object_key": self.object_key,
            "cache_hash": self.cache_hash,
            "mode": self.mode,
            "upper_product_id": self.upper_product_id,
            "upper_variant_id": self.upper_variant_id,
            "lower_product_id": self.lower_product_id,
            "lower_variant_id": self.lower_variant_id,
            "one_piece_product_id": self.one_piece_product_id,
            "one_piece_variant_id": self.one_piece_variant_id,
            "user_id": self.user_id,
            "guest_session_id": self.guest_session_id,
            "ip_address": self.ip_address,
            "loyalty_tier": self.loyalty_tier,
            "correlation_id": self.correlation_id,
            "traceparent": self.traceparent,
            "simulate_failure": bool(self.simulate_failure),
            "pose_landmarks": self.pose_landmarks,
            "is_stage2": bool(self.is_stage2),
            "cache_key": self.cache_key,
            "person_frame_sha256": self.person_frame_sha256,
            "lighting_preset": self.lighting_preset,
            "garments": [dict(g) for g in self.garments],
            "storefront_url": self.storefront_url,
        }

    def to_wire_envelope(self) -> dict[str, Any]:
        return {
            "eventName": "tryon.job.queued",
            "taskType": "tryon_queued_task",
            "jobId": self.session_id,
            "sessionId": self.session_id,
            "mode": self.mode,
            "cacheKey": self.cache_key or self.cache_hash,
            "cacheHash": self.cache_hash,
            "correlationId": self.correlation_id,
            "timestamp": utcnow().isoformat(),
            "task": self.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TryOnQueuedTask:
        raw_garments = data.get("garments") or ()
        normalized_garments: tuple[dict[str, Any], ...] = tuple(
            dict(g) for g in raw_garments if isinstance(g, dict)
        )
        return cls(
            session_id=str(data["session_id"]),
            temp_image_id=str(data["temp_image_id"]),
            object_key=str(data["object_key"]),
            cache_hash=str(data["cache_hash"]),
            mode=str(data.get("mode") or "SINGLE"),
            upper_product_id=data.get("upper_product_id"),
            upper_variant_id=data.get("upper_variant_id"),
            lower_product_id=data.get("lower_product_id"),
            lower_variant_id=data.get("lower_variant_id"),
            one_piece_product_id=data.get("one_piece_product_id"),
            one_piece_variant_id=data.get("one_piece_variant_id"),
            user_id=data.get("user_id"),
            guest_session_id=data.get("guest_session_id"),
            ip_address=str(data.get("ip_address") or "127.0.0.1"),
            loyalty_tier=data.get("loyalty_tier"),
            correlation_id=str(data.get("correlation_id") or ""),
            traceparent=str(data.get("traceparent") or ""),
            simulate_failure=bool(data.get("simulate_failure", False)),
            pose_landmarks=data.get("pose_landmarks"),
            is_stage2=bool(data.get("is_stage2", False)),
            cache_key=str(data.get("cache_key") or ""),
            person_frame_sha256=str(data.get("person_frame_sha256") or ""),
            lighting_preset=str(data.get("lighting_preset") or "atelier"),
            garments=normalized_garments,
            storefront_url=str(data.get("storefront_url") or "http://127.0.0.1:3000"),
        )

    @classmethod
    def from_wire_payload(cls, payload: dict[str, Any]) -> TryOnQueuedTask:
        task_dict = payload.get("task")
        if isinstance(task_dict, dict):
            return cls.from_dict(task_dict)
        return cls.from_dict(payload)


class TryOnWorkerConsumer:
    """Durable RabbitMQ (`aio-pika` connect_robust) VTON worker with 3-tier retry -> DLQ & in-memory fallback."""

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
        self._channel: Any | None = None
        self._direct_exchange: Any | None = None
        self._dlx_exchange: Any | None = None
        self._domain_exchange: Any | None = None
        self._main_queue: Any | None = None
        self._consumer_tag: str | None = None
        self._rabbitmq_connected: bool = False
        self._worker_transport: WorkerTransport = "in_memory_fallback"

        self._queue: asyncio.Queue[TryOnQueuedTask] = asyncio.Queue()
        self._worker_tasks: list[asyncio.Task[None]] = []
        self._running = False
        self._catalog_image_cache: dict[str, str] = {}
        self._catalog_slug_by_id: dict[str, str] = {}
        self._catalog_cache_loaded_at: float = 0.0

    @property
    def rabbitmq_connected(self) -> bool:
        return bool(
            self._rabbitmq_connected
            and self._connection is not None
            and not getattr(self._connection, "is_closed", False)
            and self._channel is not None
            and not getattr(self._channel, "is_closed", False)
        )

    @property
    def worker_transport(self) -> WorkerTransport:
        return "rabbitmq" if self.rabbitmq_connected else "in_memory_fallback"

    def _start_fallback_workers(self) -> None:
        if self._worker_tasks:
            return
        self._worker_tasks = [
            asyncio.create_task(
                self._worker_loop(idx),
                name=f"tryon-worker-fallback-{idx}",
            )
            for idx in range(self.topology.prefetch_count)
        ]

    async def _probe_rabbitmq_tcp(self, timeout_seconds: float = 1.5) -> bool:
        if not self.rabbitmq_url:
            return False
        parsed = urlparse(self.rabbitmq_url)
        host = parsed.hostname or "127.0.0.1"
        default_port = 5671 if parsed.scheme == "amqps" else 5672
        port = parsed.port or default_port
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port),
                timeout=timeout_seconds,
            )
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return True
        except Exception:
            return False

    async def start(self) -> None:
        """
        Bootstrap durable `aio-pika` (`connect_robust`) consumer on `tryon.jobs` with
        3-tier delayed retries (`2s -> 10s -> 30s`) and DLQ (`atelier.tryon.dlq`).
        Falls back cleanly to in-memory `asyncio.Queue` ONLY if RabbitMQ is unreachable.
        """
        if self._running:
            return
        self._running = True

        if aio_pika is not None and self.rabbitmq_url:
            tcp_ok = await self._probe_rabbitmq_tcp(timeout_seconds=1.5)
            if tcp_ok:
                try:
                    self._connection = await asyncio.wait_for(
                        aio_pika.connect_robust(self.rabbitmq_url, timeout=5),
                        timeout=6.0,
                    )
                    close_cbs = getattr(self._connection, "close_callbacks", None)
                    if close_cbs is not None and hasattr(close_cbs, "add"):
                        close_cbs.add(self._on_rabbitmq_closed)
                    reconnect_cbs = getattr(self._connection, "reconnect_callbacks", None)
                    if reconnect_cbs is not None and hasattr(reconnect_cbs, "add"):
                        reconnect_cbs.add(self._on_rabbitmq_reconnected)

                    self._channel = await self._connection.channel()
                    self._main_queue = await self.declare_topology(self._channel)
                    self._consumer_tag = await self._main_queue.consume(
                        self._on_rabbitmq_message,
                        no_ack=False,
                    )
                    self._rabbitmq_connected = True
                    self._worker_transport = "rabbitmq"
                    logger.info(
                        "Started durable RabbitMQ consumer on '%s' (prefetch=%d, retryTiersMs=%s, dlq='%s')",
                        self.topology.queue,
                        self.topology.prefetch_count,
                        self.topology.retry_tiers_ms,
                        self.topology.dlq,
                    )
                    return
                except Exception as exc:
                    logger.warning(
                        "RabbitMQ durable consumer bootstrap failed (%s: %s); falling back to in-memory asyncio.Queue.",
                        exc.__class__.__name__,
                        str(exc)[:220],
                    )
                    await self._close_rabbitmq_resources()
            else:
                logger.info(
                    "RabbitMQ broker unreachable at %s; starting in-memory asyncio.Queue fallback workers.",
                    urlparse(self.rabbitmq_url).netloc or self.rabbitmq_url,
                )

        self._rabbitmq_connected = False
        self._worker_transport = "in_memory_fallback"
        self._start_fallback_workers()

    def _on_rabbitmq_closed(self, *_args: Any, **_kwargs: Any) -> None:
        self._rabbitmq_connected = False
        self._worker_transport = "in_memory_fallback"
        logger.warning("RabbitMQ connection closed; worker transport degraded until reconnect.")

    def _on_rabbitmq_reconnected(self, *_args: Any, **_kwargs: Any) -> None:
        self._rabbitmq_connected = True
        self._worker_transport = "rabbitmq"
        logger.info("RabbitMQ robust connection restored; workerTransport=rabbitmq.")

    async def _close_rabbitmq_resources(self) -> None:
        self._rabbitmq_connected = False
        self._worker_transport = "in_memory_fallback"
        if self._main_queue is not None and self._consumer_tag:
            try:
                await self._main_queue.cancel(self._consumer_tag)
            except Exception:
                pass
        self._consumer_tag = None
        self._main_queue = None
        self._direct_exchange = None
        self._dlx_exchange = None
        self._domain_exchange = None
        if self._channel is not None:
            try:
                if not getattr(self._channel, "is_closed", False):
                    await self._channel.close()
            except Exception:
                pass
            self._channel = None
        if self._connection is not None:
            try:
                if not getattr(self._connection, "is_closed", False):
                    await self._connection.close()
            except Exception:
                pass
            self._connection = None

    async def stop(self) -> None:
        self._running = False
        await self._close_rabbitmq_resources()
        for task in self._worker_tasks:
            task.cancel()
        for task in self._worker_tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._worker_tasks.clear()

    async def enqueue(self, item: TryOnQueuedTask) -> None:
        """
        Publish full serialized `TryOnQueuedTask` with `DeliveryMode.PERSISTENT` to RabbitMQ
        (`atelier.tryon.direct` -> `tryon.jobs`) when connected (ZERO double-execution!).
        Falls back to local `asyncio.Queue` ONLY when RabbitMQ is unavailable.
        """
        if self.rabbitmq_connected and self._direct_exchange is not None and Message is not None:
            try:
                body = json.dumps(item.to_wire_envelope()).encode("utf-8")
                await self._direct_exchange.publish(
                    Message(
                        body=body,
                        delivery_mode=DeliveryMode.PERSISTENT,
                        content_type="application/json",
                        headers={
                            "x-retry-attempt": 0,
                            "x-retry-count": 0,
                            "x-correlation-id": item.correlation_id,
                            "x-fast-dlq": bool(item.simulate_failure),
                        },
                    ),
                    routing_key=self.topology.routing_key,
                )
                return
            except Exception as exc:
                logger.warning(
                    "RabbitMQ publish failed for session %s (%s); falling back to local asyncio.Queue.",
                    item.session_id,
                    exc.__class__.__name__,
                )
                self._rabbitmq_connected = False
                self._worker_transport = "in_memory_fallback"

        if self._running:
            self._start_fallback_workers()
            await self._queue.put(item)
        else:
            asyncio.create_task(
                self.execute_session(item),
                name=f"tryon-job-fallback-{item.session_id[:8]}",
            )

    async def _worker_loop(self, worker_index: int) -> None:
        while self._running:
            item = await self._queue.get()
            try:
                await self.execute_session(item)
            except Exception as exc:
                logger.exception(
                    "Fallback worker %d unhandled error for session %s: %s",
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
            if (
                exchange_name == self.topology.domain_exchange
                and self.rabbitmq_connected
                and self._domain_exchange is not None
            ):
                await self._domain_exchange.publish(
                    Message(
                        body=json.dumps(payload).encode("utf-8"),
                        delivery_mode=DeliveryMode.PERSISTENT,
                        content_type="application/json",
                    ),
                    routing_key=routing_key,
                )
                return
            if not self.rabbitmq_connected:
                return
            if self._channel is not None and not getattr(self._channel, "is_closed", False):
                ex_type = (
                    ExchangeType.TOPIC if exchange_type == "topic" else ExchangeType.DIRECT
                )
                exchange = await self._channel.declare_exchange(
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
            # Non-fatal telemetry mirror
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

    async def _fetch_url_or_minio_bytes(
        self,
        image_url: str,
        *,
        storefront_url: str = "http://127.0.0.1:3000",
    ) -> bytes | None:
        if not image_url:
            return None

        cleaned = image_url.strip()

        # 0. Inline base64 data URL
        if cleaned.lower().startswith("data:") and "," in cleaned:
            try:
                b64_part = cleaned.split(",", 1)[1].strip()
                raw = base64.b64decode(b64_part)
                if raw and len(raw) > 128:
                    return raw
            except Exception:
                return None

        # 1. Handle relative storefront asset paths (`/images/...`, `/seasons-lookbook/...`)
        if cleaned.startswith("/"):
            public_dir = (REPO_ROOT / "apps" / "storefront" / "public").resolve()
            rel_path = cleaned.split("?", 1)[0].lstrip("/")
            try:
                candidate = (public_dir / rel_path).resolve()
                candidate.relative_to(public_dir)
                if candidate.is_file():
                    data = candidate.read_bytes()
                    if data and len(data) > 128:
                        return data
            except Exception:
                pass

            # Fallback to live Storefront HTTP on 127.0.0.1:3000
            sf_base = (storefront_url or "http://127.0.0.1:3000").rstrip("/").replace(
                "http://localhost:", "http://127.0.0.1:"
            )
            cleaned = f"{sf_base}{cleaned}"

        # 2. Handle minio://bucket/key directly
        if cleaned.startswith("minio://") and self.minio is not None:
            parsed = urlparse(cleaned)
            bucket = parsed.netloc
            key = parsed.path.lstrip("/")
            if bucket and key:
                try:
                    return await self.minio.get_object_bytes(bucket=bucket, key=key)
                except Exception:
                    pass

        # 3. Normalize localhost -> 127.0.0.1 for reliable Windows loopback HTTP fetch
        fetch_url = cleaned.replace("http://localhost:", "http://127.0.0.1:")
        if fetch_url.startswith("http://") or fetch_url.startswith("https://"):
            try:
                async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
                    r = await client.get(fetch_url)
                    if r.status_code == 200 and r.content and len(r.content) > 128:
                        return r.content
            except Exception:
                pass

            # 4. Direct MinIO S3 fallback if URL points to known MinIO buckets
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

    async def _invoke_provider_step(
        self,
        *,
        person_bytes: bytes,
        garment_bytes: bytes | None,
        garment_url: str | None,
        slot: str,
        garment_name: str,
        color_hex: str | None,
        color_name: str | None,
        lighting_preset: str,
        pose_landmarks: dict[str, Any] | list[dict[str, Any]] | None,
        step_order: int,
        total_steps: int,
        correlation_id: str,
    ) -> tuple[bytes, str, str, str, str, float, int]:
        """
        Invoke Stage 2 `provider.synthesize(TryOnGenerationRequest)` when supported,
        with clean fallback to legacy `provider.render_step(...)`.
        Returns (image_bytes, content_type, provider_used, provider_badge, external_job_id, cost_usd, latency_ms).
        """
        cloth_type = normalize_cloth_type(slot)
        if hasattr(self.provider, "synthesize"):
            gen_req = TryOnGenerationRequest(
                person_bytes=person_bytes,
                garment_bytes=garment_bytes,
                garment_image_url=garment_url,
                cloth_type=cloth_type,
                garment_name=garment_name,
                color_hex=color_hex,
                color_name=color_name,
                lighting_preset=lighting_preset,
                pose_landmarks=pose_landmarks,
                step_order=step_order,
                total_steps=total_steps,
                correlation_id=correlation_id,
            )
            gen_res = await self.provider.synthesize(gen_req)
            provider_used = str(
                getattr(gen_res, "provider_used", None)
                or getattr(gen_res, "provider_type", None)
                or self.provider.provider_type
            )
            provider_badge = str(
                getattr(gen_res, "provider_badge", None)
                or get_provider_display_badge(provider_used)
            )
            return (
                gen_res.result_bytes,
                getattr(gen_res, "content_type", "image/webp") or "image/webp",
                provider_used,
                provider_badge,
                getattr(gen_res, "external_job_id", "") or f"{provider_used}_step_{step_order}",
                float(getattr(gen_res, "estimated_cost_usd", 0.0) or 0.0),
                int(getattr(gen_res, "latency_ms", 1) or 1),
            )

        category: VTONStepCategory = (
            "LOWER"
            if cloth_type == "lower"
            else ("OVERALL" if cloth_type == "overall" else "UPPER")
        )
        step_res = await self.provider.render_step(
            person_image_bytes=person_bytes,
            garment_image_bytes=garment_bytes,
            garment_image_url=garment_url,
            garment_category=category,
            garment_label=garment_name,
            step_order=step_order,
            total_steps=total_steps,
            pose_landmarks=pose_landmarks if isinstance(pose_landmarks, dict) else None,
        )
        provider_used = str(
            getattr(step_res, "provider_used", None) or step_res.provider_type
        )
        provider_badge = (
            step_res.provider_display_badge
            or get_provider_display_badge(provider_used)
        )
        return (
            step_res.image_bytes,
            step_res.content_type,
            provider_used,
            provider_badge,
            step_res.external_job_id,
            step_res.estimated_cost_usd,
            step_res.latency_ms,
        )

    async def _sync_stage2_progress(
        self,
        *,
        task: TryOnQueuedTask,
        status_val: str,
        db_status: str,
        progress_pct: int,
        stage_label: str,
        step_current: int,
        step_total: int,
        quota_remaining: int,
        expires_at_iso: str,
        expires_in_seconds: int,
        provider_used: str | None = None,
        provider_badge: str | None = None,
        job_status: str | None = None,
    ) -> None:
        await self._update_session_progress(
            session_id=task.session_id,
            status=db_status,
            progress_pct=progress_pct,
            step_order=step_current,
            step_message=stage_label,
            job_status=job_status,
        )
        state_payload: dict[str, Any] = {
            "jobId": task.session_id,
            "sessionId": task.session_id,
            "status": status_val,
            "mode": task.mode,
            "progressPct": progress_pct,
            "stageLabel": stage_label,
            "stepMessage": stage_label,
            "stepCurrent": step_current,
            "stepOrder": step_current,
            "stepTotal": step_total,
            "totalSteps": step_total,
            "resultUrl": None,
            "providerUsed": provider_used,
            "providerBadge": provider_badge,
            "providerDisplayBadge": provider_badge,
            "cacheHit": False,
            "cacheKey": task.cache_key,
            "errorCode": None,
            "errorMessage": None,
            "expiresAt": expires_at_iso,
            "expiresInSeconds": expires_in_seconds,
            "quotaRemaining": quota_remaining,
            "remainingQuota": quota_remaining,
        }
        await self.cache_quota.set_job_state(
            task.session_id,
            state_payload,
            ttl_seconds=self.presign_get_ttl_seconds,
        )
        await self._emit_realtime_event(
            event_name="tryon:progress",
            session_id=task.session_id,
            correlation_id=task.correlation_id,
            traceparent=task.traceparent,
            payload=state_payload,
        )

    async def _execute_stage2_session(
        self,
        task: TryOnQueuedTask,
        *,
        defer_failure_finalization: bool = False,
        raise_on_transient_error: bool = False,
    ) -> None:
        if self.db is None or self.minio is None:
            raise RuntimeError("Worker requires initialized TryOnDatabase and MinioStorageClient.")

        started = time.perf_counter()
        quota_snap = await self.cache_quota.get_dual_quota(
            user_id=task.user_id,
            ip_address=task.ip_address,
            loyalty_tier=task.loyalty_tier,
        )

        ordered_garments = sort_garments_physically([dict(g) for g in task.garments])
        if not ordered_garments:
            raise RuntimeError("No garments provided for Stage 2 try-on synthesis.")

        total_steps = len(ordered_garments)
        initial_expires_at = utcnow() + timedelta(minutes=self.purge_ttl_minutes)
        initial_expires_iso = initial_expires_at.isoformat()

        async def _check_cancelled() -> bool:
            if await self.cache_quota.is_job_cancelled(task.session_id):
                refunded = await self.cache_quota.refund_quota(
                    task.user_id,
                    task.ip_address,
                    loyalty_tier=task.loyalty_tier,
                    job_id=task.session_id,
                )
                now_c = utcnow()
                async with self.db.session() as db_sess:
                    srow = await db_sess.get(TryOnSession, task.session_id)
                    if srow is not None and srow.status not in ("COMPLETED", "FAILED"):
                        srow.status = "CANCELLED"
                        srow.step_message = "Đã hủy tác vụ thử đồ — Đã hoàn trả +1 lượt thử AI"
                        srow.completed_at = now_c
                    jres = await db_sess.execute(
                        select(TryOnJob).where(TryOnJob.session_id == task.session_id)
                    )
                    for job in jres.scalars().all():
                        if job.status in ("QUEUED", "PROCESSING"):
                            job.status = "CANCELLED"
                    await db_sess.commit()
                await self.cache_quota.set_job_state(
                    task.session_id,
                    {
                        "jobId": task.session_id,
                        "sessionId": task.session_id,
                        "status": "CANCELLED",
                        "progressPct": 0,
                        "stageLabel": "Đã hủy tác vụ thử đồ",
                        "stepCurrent": 0,
                        "stepTotal": total_steps,
                        "resultUrl": None,
                        "providerUsed": None,
                        "providerBadge": None,
                        "cacheHit": False,
                        "cacheKey": task.cache_key,
                        "errorCode": "JOB_CANCELLED",
                        "errorMessage": "Tác vụ thử đồ đã được người dùng hủy.",
                        "expiresAt": initial_expires_iso,
                        "expiresInSeconds": self.presign_get_ttl_seconds,
                        "quotaRemaining": refunded.remaining_quota,
                    },
                    ttl_seconds=300,
                )
                return True
            return False

        try:
            if await _check_cancelled():
                return

            # Milestone 15%: Load source portrait & analyze pose / old garment segmentation
            await self._sync_stage2_progress(
                task=task,
                status_val="PROCESSING",
                db_status="PROCESSING_STEP_1",
                progress_pct=15,
                stage_label="Đang phân tích khung dáng & tách lớp trang phục cũ...",
                step_current=1,
                step_total=total_steps,
                quota_remaining=quota_snap.remaining_quota,
                expires_at_iso=initial_expires_iso,
                expires_in_seconds=self.presign_get_ttl_seconds,
                job_status="PROCESSING",
            )

            current_image_bytes = await self.minio.get_object_bytes(key=task.object_key)
            if not current_image_bytes:
                raise RuntimeError(
                    f"Source portrait object '{task.object_key}' not found in {self.minio.private_bucket}."
                )

            if task.simulate_failure:
                await asyncio.sleep(0.08)
                raise RuntimeError(
                    "Simulated VTON provider failure (simulateFailure=true) — automatic quota refund triggered."
                )

            final_content_type = "image/webp"
            actual_provider_used = str(self.provider.provider_type)
            actual_provider_badge = get_provider_display_badge(actual_provider_used)

            for idx, garment in enumerate(ordered_garments, start=1):
                if await _check_cancelled():
                    return

                slot_norm = normalize_garment_slot(str(garment.get("slot") or "upper"))
                prod_id = str(garment.get("productId") or garment.get("product_id") or "").strip()
                var_id = str(garment.get("variantId") or garment.get("variant_id") or "").strip() or None
                garment_name = str(garment.get("name") or prod_id or "garment").strip()
                raw_garment_url = str(
                    garment.get("garmentImageUrl")
                    or garment.get("garment_image_url")
                    or garment.get("cleanGarmentUrl768x1024")
                    or ""
                ).strip()
                color_hex = str(garment.get("colorHex") or garment.get("color_hex") or "").strip() or None
                color_name = str(garment.get("colorName") or garment.get("color_name") or "").strip() or None

                # Determine exact progress pct & Vietnamese stageLabel for this step
                if idx == 1:
                    step_pct = 45
                    step_label = f"Đang ướm phom vải & xử lý cổ áo (Bước 1/{total_steps})..."
                    db_step_status = "PROCESSING_STEP_1"
                elif idx == 2:
                    step_pct = 72
                    if slot_norm == "outerwear":
                        step_label = f"Đang khoác thêm lớp áo ngoài (Bước 2/{total_steps})..."
                    else:
                        step_label = f"Đang phối tiếp trang phục thân dưới (Bước 2/{total_steps})..."
                    db_step_status = "PROCESSING_STEP_2"
                else:
                    step_pct = 80
                    step_label = f"Đang khoác thêm lớp áo ngoài (Bước {idx}/{total_steps})..."
                    db_step_status = "PROCESSING_STEP_2"

                # Step 1 Intermediate Cache check for OUTFIT mode (skip Step 1 when Top unchanged & Bottom changed!)
                step1_cache_key = ""
                if idx == 1 and total_steps >= 2 and task.person_frame_sha256:
                    step1_cache_key = compute_v2_step1_cache_key(
                        person_frame_sha256=task.person_frame_sha256,
                        step1_garment=garment,
                        lighting_preset=task.lighting_preset,
                    )
                    cached_step1 = await self.cache_quota.get_cached(step1_cache_key)
                    cached_s1_key = (
                        str(cached_step1.get("step1ObjectKey"))
                        if isinstance(cached_step1, dict) and cached_step1.get("step1ObjectKey")
                        else None
                    )
                    if cached_s1_key and await self.minio.head_object(key=cached_s1_key):
                        s1_bytes = await self.minio.get_object_bytes(key=cached_s1_key)
                        if s1_bytes:
                            current_image_bytes = s1_bytes
                            final_content_type = str(
                                cached_step1.get("contentType") or "image/webp"
                            )
                            actual_provider_used = str(
                                cached_step1.get("providerUsed") or actual_provider_used
                            )
                            actual_provider_badge = str(
                                cached_step1.get("providerBadge") or actual_provider_badge
                            )
                            await self._sync_stage2_progress(
                                task=task,
                                status_val="PROCESSING",
                                db_status=db_step_status,
                                progress_pct=step_pct,
                                stage_label=f"Tái sử dụng lớp áo từ bộ nhớ đệm (Bước 1/{total_steps})...",
                                step_current=1,
                                step_total=total_steps,
                                quota_remaining=quota_snap.remaining_quota,
                                expires_at_iso=initial_expires_iso,
                                expires_in_seconds=self.presign_get_ttl_seconds,
                                provider_used=actual_provider_used,
                                provider_badge=actual_provider_badge,
                                job_status="PROCESSING",
                            )
                            await self._mark_job_completed(
                                session_id=task.session_id,
                                step_order=1,
                                external_job_id="step1_cache_hit",
                                estimated_cost_usd=0.0,
                                api_latency_ms=1,
                            )
                            continue

                await self._sync_stage2_progress(
                    task=task,
                    status_val="PROCESSING",
                    db_status=db_step_status,
                    progress_pct=step_pct,
                    stage_label=step_label,
                    step_current=idx,
                    step_total=total_steps,
                    quota_remaining=quota_snap.remaining_quota,
                    expires_at_iso=initial_expires_iso,
                    expires_in_seconds=self.presign_get_ttl_seconds,
                    provider_used=actual_provider_used,
                    provider_badge=actual_provider_badge,
                    job_status="PROCESSING",
                )

                # Fetch garment bytes cleanly (relative storefront /images, local public/, MinIO, HTTP, or catalog fallback)
                garment_bytes: bytes | None = None
                garment_url: str | None = raw_garment_url or None
                if raw_garment_url:
                    garment_bytes = await self._fetch_url_or_minio_bytes(
                        raw_garment_url,
                        storefront_url=task.storefront_url,
                    )
                if not garment_bytes and prod_id:
                    resolved_bytes, resolved_url, resolved_label = await self._resolve_garment_image(
                        prod_id,
                        var_id,
                    )
                    if resolved_bytes:
                        garment_bytes = resolved_bytes
                    if resolved_url and not garment_url:
                        garment_url = resolved_url
                    if resolved_label and not garment_name:
                        garment_name = resolved_label

                (
                    step_bytes,
                    step_ct,
                    step_provider_used,
                    step_provider_badge,
                    step_ext_id,
                    step_cost_usd,
                    step_latency_ms,
                ) = await self._invoke_provider_step(
                    person_bytes=current_image_bytes,
                    garment_bytes=garment_bytes,
                    garment_url=garment_url,
                    slot=slot_norm,
                    garment_name=garment_name,
                    color_hex=color_hex,
                    color_name=color_name,
                    lighting_preset=task.lighting_preset,
                    pose_landmarks=task.pose_landmarks,
                    step_order=idx,
                    total_steps=total_steps,
                    correlation_id=task.correlation_id,
                )

                current_image_bytes = step_bytes
                final_content_type = step_ct
                actual_provider_used = step_provider_used
                actual_provider_badge = step_provider_badge

                await self._mark_job_completed(
                    session_id=task.session_id,
                    step_order=idx,
                    external_job_id=step_ext_id,
                    estimated_cost_usd=step_cost_usd,
                    api_latency_ms=step_latency_ms,
                )

                # Cache intermediate Step 1 result for OUTFIT mode (TTL 900s)
                if idx == 1 and total_steps >= 2 and step1_cache_key:
                    s1_ext = (
                        "png"
                        if final_content_type == "image/png"
                        else ("jpg" if final_content_type == "image/jpeg" else "webp")
                    )
                    s1_obj_key = f"intermediate/{task.session_id}_step1.{s1_ext}"
                    try:
                        await self.minio.put_object_bytes(
                            key=s1_obj_key,
                            data=current_image_bytes,
                            content_type=final_content_type,
                        )
                        await self.cache_quota.set_cached(
                            step1_cache_key,
                            {
                                "step1ObjectKey": s1_obj_key,
                                "contentType": final_content_type,
                                "providerUsed": actual_provider_used,
                                "providerBadge": actual_provider_badge,
                                "sessionId": task.session_id,
                                "createdAt": utcnow().isoformat(),
                            },
                            ttl_seconds=self.presign_get_ttl_seconds,
                        )
                    except Exception as cache_exc:
                        logger.debug("Step 1 intermediate cache store skipped: %s", cache_exc)

            if await _check_cancelled():
                return

            # Milestone 85%: Final crease/fold harmonizing & 768x1024 output normalization
            await self._sync_stage2_progress(
                task=task,
                status_val="PROCESSING",
                db_status="PROCESSING_STEP_2" if total_steps > 1 else "PROCESSING_STEP_1",
                progress_pct=85,
                stage_label="Đang dệt nếp gấp & cân bằng ánh sáng phòng...",
                step_current=total_steps,
                step_total=total_steps,
                quota_remaining=quota_snap.remaining_quota,
                expires_at_iso=initial_expires_iso,
                expires_in_seconds=self.presign_get_ttl_seconds,
                provider_used=actual_provider_used,
                provider_badge=actual_provider_badge,
            )

            current_image_bytes, final_content_type = await asyncio.to_thread(
                _normalize_output_768x1024,
                current_image_bytes,
                final_content_type,
            )

            ext = (
                "png"
                if final_content_type == "image/png"
                else ("jpg" if final_content_type == "image/jpeg" else "webp")
            )
            result_object_key = f"results/{task.session_id}.{ext}"
            await self.minio.put_object_bytes(
                key=result_object_key,
                data=current_image_bytes,
                content_type=final_content_type,
            )

            now = utcnow()
            expires_at = now + timedelta(minutes=self.purge_ttl_minutes)
            expires_at_iso = expires_at.isoformat()
            total_duration_ms = max(1, int((time.perf_counter() - started) * 1000))
            result_url = await self.minio.generate_presigned_get_url(
                key=result_object_key,
                expires_in=self.presign_get_ttl_seconds,
            )

            # Write Stage 2 `tryon:v2:` Redis cache (TTL = 900s) BEFORE marking DB COMPLETED
            # so any immediate repeat request after polling/Socket.io completion is guaranteed a Cache HIT!
            cache_store_key = task.cache_key or task.cache_hash
            await self.cache_quota.set_cached(
                cache_store_key,
                {
                    "resultObjectKey": result_object_key,
                    "sessionId": task.session_id,
                    "jobId": task.session_id,
                    "mode": task.mode,
                    "stepTotal": total_steps,
                    "providerUsed": actual_provider_used,
                    "providerBadge": actual_provider_badge,
                    "providerDisplayBadge": actual_provider_badge,
                    "lightingPreset": task.lighting_preset,
                    "createdAt": now.isoformat(),
                    "expiresAt": expires_at_iso,
                },
                ttl_seconds=self.presign_get_ttl_seconds,
            )

            completed_payload: dict[str, Any] = {
                "jobId": task.session_id,
                "sessionId": task.session_id,
                "status": "COMPLETED",
                "mode": task.mode,
                "providerUsed": actual_provider_used,
                "providerBadge": actual_provider_badge,
                "providerDisplayBadge": actual_provider_badge,
                "cleanCollarApplied": True,
                "progressPct": 100,
                "stageLabel": "Hoàn tất ướm thử",
                "stepMessage": "Hoàn tất ướm thử",
                "stepCurrent": total_steps,
                "stepOrder": total_steps,
                "stepTotal": total_steps,
                "totalSteps": total_steps,
                "resultUrl": result_url,
                "resultImageUrl": result_url,
                "cacheHit": False,
                "cacheKey": task.cache_key,
                "errorCode": None,
                "errorMessage": None,
                "expiresAt": expires_at_iso,
                "purgeAt": expires_at_iso,
                "expiresInSeconds": self.presign_get_ttl_seconds,
                "totalDurationMs": total_duration_ms,
                "quotaRemaining": quota_snap.remaining_quota,
                "remainingQuota": quota_snap.remaining_quota,
                "isPurged": False,
            }
            await self.cache_quota.set_job_state(
                task.session_id,
                completed_payload,
                ttl_seconds=self.presign_get_ttl_seconds,
            )

            # Persist TryOnResult, update TryOnSession=COMPLETED, record anonymous THU_THANH_CONG signal
            async with self.db.session() as db_sess:
                sess_row = await db_sess.get(TryOnSession, task.session_id)
                if sess_row is not None:
                    sess_row.status = "COMPLETED"
                    sess_row.provider_used = actual_provider_used[:32]
                    sess_row.provider_display_badge = actual_provider_badge[:96]
                    sess_row.error_code = None
                    sess_row.error_message = None
                    sess_row.progress_pct = 100
                    sess_row.step_order = total_steps
                    sess_row.step_message = "Hoàn tất ướm thử"
                    sess_row.total_duration_ms = total_duration_ms
                    sess_row.expires_at = expires_at
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

                seen_pids: set[str] = set()
                for g in ordered_garments:
                    pid = str(g.get("productId") or g.get("product_id") or "").strip()
                    vid = str(g.get("variantId") or g.get("variant_id") or "").strip() or None
                    if pid and pid not in seen_pids:
                        seen_pids.add(pid)
                        db_sess.add(
                            TryOnDemandEvent(
                                id=str(uuid4()),
                                product_id=pid,
                                sku_id=vid,
                                session_id=task.session_id,
                                user_id=task.user_id,
                                signal_type="THU_THANH_CONG",
                                created_at=now,
                            )
                        )
                await db_sess.commit()

            await self._emit_realtime_event(
                event_name="tryon:completed",
                session_id=task.session_id,
                correlation_id=task.correlation_id,
                traceparent=task.traceparent,
                payload=completed_payload,
            )

        except Exception as exc:
            is_pose_err = isinstance(exc, PoseTooCloseError) or getattr(exc, "code", "") in (
                "POSE_TOO_CLOSE",
                "NO_PERSON_DETECTED",
            )
            if (not is_pose_err) and defer_failure_finalization:
                raise

            error_code = (
                str(getattr(exc, "code", "") or "POSE_TOO_CLOSE")
                if is_pose_err
                else ("SIMULATED_FAILURE" if task.simulate_failure else "VTON_SYNTHESIS_FAILED")
            )
            error_msg = (
                str(getattr(exc, "message", "") or exc)
                if is_pose_err
                else (
                    "Không thể xử lý ảnh thử đồ lúc này — Đã hoàn trả lại +1 lượt thử đồ AI."
                )
            )
            total_duration_ms = max(1, int((time.perf_counter() - started) * 1000))
            now = utcnow()

            refunded_snap = await self.cache_quota.refund_quota(
                task.user_id,
                task.ip_address,
                loyalty_tier=task.loyalty_tier,
                job_id=task.session_id,
            )
            default_badge = get_provider_display_badge(self.provider.provider_type)
            stage_fail_label = (
                "Ảnh chụp chưa đạt khung chuẩn — Đã hoàn trả +1 lượt thử đồ AI"
                if is_pose_err
                else "Xử lý thất bại — Đã hoàn trả +1 lượt thử đồ AI"
            )

            async with self.db.session() as db_sess:
                sess_row = await db_sess.get(TryOnSession, task.session_id)
                if sess_row is not None:
                    sess_row.status = "FAILED"
                    sess_row.error_code = error_code[:64]
                    sess_row.error_message = error_msg
                    sess_row.provider_display_badge = default_badge
                    sess_row.step_message = stage_fail_label
                    sess_row.total_duration_ms = total_duration_ms
                    sess_row.completed_at = now
                jobs_res = await db_sess.execute(
                    select(TryOnJob).where(TryOnJob.session_id == task.session_id)
                )
                for job in jobs_res.scalars().all():
                    if job.status in ("QUEUED", "PROCESSING"):
                        job.status = "FAILED"
                await db_sess.commit()

            failed_payload: dict[str, Any] = {
                "jobId": task.session_id,
                "sessionId": task.session_id,
                "status": "FAILED",
                "mode": task.mode,
                "providerUsed": str(self.provider.provider_type),
                "providerBadge": default_badge,
                "providerDisplayBadge": default_badge,
                "progressPct": 0,
                "stageLabel": stage_fail_label,
                "stepMessage": stage_fail_label,
                "stepCurrent": 0,
                "stepOrder": 0,
                "stepTotal": total_steps,
                "totalSteps": total_steps,
                "resultUrl": None,
                "resultImageUrl": None,
                "cacheHit": False,
                "cacheKey": task.cache_key,
                "errorCode": error_code,
                "message": error_msg,
                "errorMessage": error_msg,
                "expiresAt": initial_expires_iso,
                "expiresInSeconds": 0,
                "totalDurationMs": total_duration_ms,
                "quotaRemaining": refunded_snap.remaining_quota,
                "remainingQuota": refunded_snap.remaining_quota,
                "quotaRefunded": True,
            }
            await self.cache_quota.set_job_state(
                task.session_id,
                failed_payload,
                ttl_seconds=300,
            )
            await self._emit_realtime_event(
                event_name="tryon:failed",
                session_id=task.session_id,
                correlation_id=task.correlation_id,
                traceparent=task.traceparent,
                payload=failed_payload,
            )
            if (not is_pose_err) and raise_on_transient_error:
                raise

    async def execute_session(
        self,
        task: TryOnQueuedTask,
        *,
        defer_failure_finalization: bool = False,
        raise_on_transient_error: bool = False,
    ) -> None:
        if task.is_stage2 and task.garments:
            await self._execute_stage2_session(
                task,
                defer_failure_finalization=defer_failure_finalization,
                raise_on_transient_error=raise_on_transient_error,
            )
            return

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
            if defer_failure_finalization:
                raise

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
            if raise_on_transient_error:
                raise

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
    # Durable RabbitMQ topology & 3-tier retry -> DLQ consumer methods (P2-4.1)
    # -------------------------------------------------------------------------

    async def _reopen_channel_after_precondition(self, channel: Any) -> Any:
        conn = self._connection or getattr(channel, "connection", None)
        if conn is not None and not getattr(conn, "is_closed", False):
            new_ch = await conn.channel()
            await new_ch.set_qos(prefetch_count=self.topology.prefetch_count)
            self._channel = new_ch
            return new_ch
        return channel

    async def _declare_exchange_safe(
        self,
        channel: Any,
        name: str,
        exchange_type: Any,
        *,
        durable: bool = True,
    ) -> tuple[Any, Any]:
        try:
            ex = await channel.declare_exchange(name, exchange_type, durable=durable)
            return channel, ex
        except ChannelPreconditionFailed as exc:
            logger.warning(
                "Exchange '%s' already exists with different attributes (%s); attaching passively.",
                name,
                exc,
            )
            channel = await self._reopen_channel_after_precondition(channel)
            ex = await channel.declare_exchange(name, exchange_type, passive=True)
            return channel, ex

    async def _declare_queue_safe(
        self,
        channel: Any,
        name: str,
        *,
        durable: bool = True,
        arguments: dict[str, Any] | None = None,
    ) -> tuple[Any, Any]:
        try:
            q = await channel.declare_queue(
                name,
                durable=durable,
                arguments=arguments,
            )
            return channel, q
        except ChannelPreconditionFailed as exc:
            logger.warning(
                "Queue '%s' already exists with different arguments (%s); attaching passively without crashing.",
                name,
                exc,
            )
            channel = await self._reopen_channel_after_precondition(channel)
            q = await channel.declare_queue(name, passive=True)
            return channel, q

    async def declare_topology(self, channel: Any) -> Any:
        await channel.set_qos(prefetch_count=self.topology.prefetch_count)

        channel, direct_exchange = await self._declare_exchange_safe(
            channel,
            self.topology.exchange,
            ExchangeType.DIRECT,
            durable=True,
        )
        channel, dlx_exchange = await self._declare_exchange_safe(
            channel,
            self.topology.dlx,
            ExchangeType.DIRECT,
            durable=True,
        )
        channel, domain_exchange = await self._declare_exchange_safe(
            channel,
            self.topology.domain_exchange,
            ExchangeType.TOPIC,
            durable=True,
        )

        # Dead-Letter Queue bound to `atelier.tryon.dlx` with BOTH `atelier.tryon.dlq` AND `tryon.jobs`
        prev_ch = channel
        channel, dlq = await self._declare_queue_safe(
            channel,
            self.topology.dlq,
            durable=True,
        )
        if channel is not prev_ch:
            channel, direct_exchange = await self._declare_exchange_safe(
                channel, self.topology.exchange, ExchangeType.DIRECT, durable=True
            )
            channel, dlx_exchange = await self._declare_exchange_safe(
                channel, self.topology.dlx, ExchangeType.DIRECT, durable=True
            )
            channel, domain_exchange = await self._declare_exchange_safe(
                channel, self.topology.domain_exchange, ExchangeType.TOPIC, durable=True
            )
        await dlq.bind(dlx_exchange, routing_key=self.topology.dlq)
        await dlq.bind(dlx_exchange, routing_key=self.topology.routing_key)

        # 3 Durable Delayed Retry Queues (2s -> 10s -> 30s) -> dead-letter back to `tryon.jobs`
        for idx, ttl_ms in enumerate(self.topology.retry_tiers_ms, start=1):
            retry_queue_name = f"atelier.tryon.retry.{idx}"
            prev_ch = channel
            channel, retry_queue = await self._declare_queue_safe(
                channel,
                retry_queue_name,
                durable=True,
                arguments={
                    "x-message-ttl": ttl_ms,
                    "x-dead-letter-exchange": self.topology.exchange,
                    "x-dead-letter-routing-key": self.topology.routing_key,
                },
            )
            if channel is not prev_ch:
                channel, direct_exchange = await self._declare_exchange_safe(
                    channel, self.topology.exchange, ExchangeType.DIRECT, durable=True
                )
                channel, dlx_exchange = await self._declare_exchange_safe(
                    channel, self.topology.dlx, ExchangeType.DIRECT, durable=True
                )
                channel, domain_exchange = await self._declare_exchange_safe(
                    channel, self.topology.domain_exchange, ExchangeType.TOPIC, durable=True
                )
            await retry_queue.bind(direct_exchange, routing_key=retry_queue_name)

        # Primary durable queue `tryon.jobs` -> dead-letters rejected messages to `atelier.tryon.dlx` / `atelier.tryon.dlq`
        prev_ch = channel
        channel, main_queue = await self._declare_queue_safe(
            channel,
            self.topology.queue,
            durable=True,
            arguments={
                "x-dead-letter-exchange": self.topology.dlx,
                "x-dead-letter-routing-key": self.topology.dlq,
            },
        )
        if channel is not prev_ch:
            channel, direct_exchange = await self._declare_exchange_safe(
                channel, self.topology.exchange, ExchangeType.DIRECT, durable=True
            )
            channel, dlx_exchange = await self._declare_exchange_safe(
                channel, self.topology.dlx, ExchangeType.DIRECT, durable=True
            )
            channel, domain_exchange = await self._declare_exchange_safe(
                channel, self.topology.domain_exchange, ExchangeType.TOPIC, durable=True
            )
        await main_queue.bind(direct_exchange, routing_key=self.topology.routing_key)

        self._channel = channel
        self._direct_exchange = direct_exchange
        self._dlx_exchange = dlx_exchange
        self._domain_exchange = domain_exchange
        return main_queue

    async def _publish_retry_or_dlq_task(
        self,
        *,
        original_body: bytes,
        task: TryOnQueuedTask,
        headers: dict[str, Any],
        attempt: int,
        fast_dlq: bool,
        error_reason: str,
    ) -> str:
        """
        Route failed task to delayed retry tier `atelier.tryon.retry.{1,2,3}` (if attempt < 3 and not fast_dlq),
        or publish full error envelope to `atelier.tryon.dlx` -> `atelier.tryon.dlq` (`DeliveryMode.PERSISTENT`).
        """
        max_retries = len(self.topology.retry_tiers_ms)
        if (not fast_dlq) and attempt < max_retries:
            next_attempt = attempt + 1
            retry_routing_key = f"atelier.tryon.retry.{next_attempt}"
            next_headers = {
                **headers,
                "x-retry-attempt": next_attempt,
                "x-retry-count": next_attempt,
                "x-last-error": error_reason[:500],
                "x-session-id": task.session_id,
                "x-correlation-id": task.correlation_id,
            }
            exchange = self._direct_exchange or (
                await self._channel.get_exchange(self.topology.exchange)
                if self._channel is not None
                else None
            )
            if exchange is not None and Message is not None:
                await exchange.publish(
                    Message(
                        body=original_body,
                        delivery_mode=DeliveryMode.PERSISTENT,
                        content_type="application/json",
                        headers=next_headers,
                    ),
                    routing_key=retry_routing_key,
                )
            return retry_routing_key

        dlq_envelope = {
            "eventName": "tryon.job.dead_lettered",
            "sessionId": task.session_id,
            "jobId": task.session_id,
            "correlationId": task.correlation_id,
            "errorCode": "SIMULATED_FAILURE" if task.simulate_failure else "VTON_WORKER_RETRIES_EXHAUSTED",
            "errorMessage": error_reason[:1000],
            "retryAttempts": attempt,
            "maxRetries": max_retries,
            "fastDlq": fast_dlq,
            "failedAt": utcnow().isoformat(),
            "task": task.to_dict(),
        }
        dlq_headers = {
            **headers,
            "x-retry-attempt": attempt,
            "x-retry-count": attempt,
            "x-dead-lettered": True,
            "x-fast-dlq": fast_dlq,
            "x-last-error": error_reason[:500],
            "x-session-id": task.session_id,
            "x-correlation-id": task.correlation_id,
        }
        dlx = self._dlx_exchange or (
            await self._channel.get_exchange(self.topology.dlx)
            if self._channel is not None
            else None
        )
        if dlx is not None and Message is not None:
            await dlx.publish(
                Message(
                    body=json.dumps(dlq_envelope).encode("utf-8"),
                    delivery_mode=DeliveryMode.PERSISTENT,
                    content_type="application/json",
                    headers=dlq_headers,
                ),
                routing_key=self.topology.dlq,
            )
        return self.topology.dlq

    async def _on_rabbitmq_message(self, message: Any) -> None:
        """Primary durable `tryon.jobs` consumer callback with strict manual ack/nack & 3-tier retry -> DLQ."""
        raw_headers = dict(getattr(message, "headers", None) or {})
        try:
            attempt = int(
                raw_headers.get("x-retry-attempt", raw_headers.get("x-retry-count", 0)) or 0
            )
        except (TypeError, ValueError):
            attempt = 0

        try:
            payload = json.loads(message.body.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("Expected JSON object payload on tryon.jobs")
        except Exception as exc:
            logger.error(
                "Corrupt/non-JSON tryon.jobs message (%s); nack(requeue=False) -> %s",
                exc,
                self.topology.dlq,
            )
            await message.nack(requeue=False)
            return

        # 1. Full TryOnQueuedTask message (primary Stage 1 & Stage 2 durable pipeline)
        is_queued_task = isinstance(payload.get("task"), dict) or (
            "session_id" in payload and "object_key" in payload
        )
        if is_queued_task:
            try:
                task = TryOnQueuedTask.from_wire_payload(payload)
            except Exception as exc:
                logger.error(
                    "Invalid TryOnQueuedTask schema (%s); nack(requeue=False) -> %s",
                    exc,
                    self.topology.dlq,
                )
                await message.nack(requeue=False)
                return

            fast_dlq = bool(task.simulate_failure or raw_headers.get("x-fast-dlq"))
            max_retries = len(self.topology.retry_tiers_ms)
            can_retry = (not fast_dlq) and (attempt < max_retries)

            try:
                await self.execute_session(
                    task,
                    defer_failure_finalization=can_retry,
                    raise_on_transient_error=True,
                )
                await message.ack()
                return
            except Exception as exc:
                error_reason = str(exc) or exc.__class__.__name__
                if can_retry:
                    next_attempt = attempt + 1
                    try:
                        await self._update_session_progress(
                            session_id=task.session_id,
                            status="QUEUED",
                            progress_pct=5,
                            step_order=1,
                            step_message=(
                                f"Tạm gián đoạn xử lý — Đang tự động thử lại lần "
                                f"{next_attempt}/{max_retries}..."
                            ),
                        )
                    except Exception:
                        pass
                try:
                    destination = await self._publish_retry_or_dlq_task(
                        original_body=message.body,
                        task=task,
                        headers=raw_headers,
                        attempt=attempt,
                        fast_dlq=fast_dlq,
                        error_reason=error_reason,
                    )
                    logger.warning(
                        "Try-on session %s attempt=%d failed (%s); routed -> %s",
                        task.session_id,
                        attempt,
                        error_reason[:180],
                        destination,
                    )
                    await message.ack()
                except Exception as route_exc:
                    logger.exception(
                        "Failed to route try-on session %s to retry/DLQ (%s); nack(requeue=False)",
                        task.session_id,
                        route_exc,
                    )
                    await message.nack(requeue=False)
                return

        # 2. Legacy Phase 0 VTONRequest payload compatibility
        if "garment_sku_id" in payload and "person_image_fingerprint" in payload:
            await self.handle_message(self._channel, message)
            return

        logger.warning(
            "Unrecognized message payload on tryon.jobs (keys=%s); nack(requeue=False) -> %s",
            list(payload.keys())[:8],
            self.topology.dlq,
        )
        await message.nack(requeue=False)

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
        retry_count = int(headers.get("x-retry-attempt", headers.get("x-retry-count", 0)) or 0)
        next_headers = {**headers, "x-last-error": error_reason}

        if retry_count < len(self.topology.retry_tiers_ms):
            tier = retry_count + 1
            next_headers["x-retry-attempt"] = tier
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
        next_headers["x-retry-attempt"] = retry_count
        next_headers["x-retry-count"] = retry_count
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
            if isinstance(payload, dict) and (
                isinstance(payload.get("task"), dict)
                or ("session_id" in payload and "object_key" in payload)
            ):
                self._channel = channel
                await self._on_rabbitmq_message(message)
                return
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
