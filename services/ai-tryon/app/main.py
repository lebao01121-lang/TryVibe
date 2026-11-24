from __future__ import annotations

import logging
import re
import secrets
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncIterator
from uuid import uuid4

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import router as tryon_router
from app.api.tryon_v1 import (
    TryOnApiError,
    build_api_error_response,
    internal_router,
    v1_router,
)
from app.cache_quota.quota import TryOnCacheQuota
from app.config import Settings, get_settings
from app.db.database import TryOnDatabase
from app.db.seed_demand import seed_baseline_demand_signals
from app.preprocessing.normalizer import GarmentNormalizer
from app.providers.mock_provider import get_vton_provider
from app.services.lookbook_studio import LookbookStudioService
from app.storage.minio_client import MinioStorageClient
from app.tasks.auto_purge import TryOnAutoPurgeTask
from app.workers.consumer import TryOnWorkerConsumer

CORRELATION_ID_HEADER = "X-Correlation-Id"
TRACEPARENT_HEADER = "traceparent"
W3C_TRACEPARENT_RE = re.compile(
    r"^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$",
    re.IGNORECASE,
)
ZERO_TRACE_ID = "0" * 32
ZERO_SPAN_ID = "0" * 16
PROCESS_STARTED_AT = time.monotonic()

logger = logging.getLogger("atelier.ai_tryon.http")


def _random_nonzero_hex(nbytes: int) -> str:
    zero = "0" * (nbytes * 2)
    for _ in range(5):
        candidate = secrets.token_hex(nbytes)
        if candidate != zero:
            return candidate
    return "1".rjust(nbytes * 2, "0")


def get_or_create_traceparent(raw_header: str | None) -> tuple[str, str, str]:
    """Validate incoming W3C `traceparent` or mint a fresh root `00-<32hex>-<16hex>-01`."""
    if raw_header:
        m = W3C_TRACEPARENT_RE.match(raw_header.strip())
        if m:
            ver, trace_id, span_id, flags = (
                m.group(1).lower(),
                m.group(2).lower(),
                m.group(3).lower(),
                m.group(4).lower(),
            )
            if ver != "ff" and trace_id != ZERO_TRACE_ID and span_id != ZERO_SPAN_ID:
                return f"{ver}-{trace_id}-{span_id}-{flags}", trace_id, span_id
    trace_id = _random_nonzero_hex(16)
    span_id = _random_nonzero_hex(8)
    return f"00-{trace_id}-{span_id}-01", trace_id, span_id


def _attach_runtime_state(app: FastAPI, settings: Settings) -> None:
    db = TryOnDatabase(
        database_url=settings.tryon_database_url,
        sqlite_path=settings.tryon_sqlite_path,
    )
    minio = MinioStorageClient(
        endpoint_url=settings.minio_endpoint_url,
        access_key=settings.minio_access_key,
        secret_key=settings.minio_secret_key,
        region=settings.minio_region,
        private_bucket=settings.minio_bucket_private_tryon,
        garments_bucket=settings.minio_bucket_garments,
        public_bucket=settings.minio_bucket_public,
    )
    provider = get_vton_provider(
        settings.vton_provider,
        private_bucket=settings.minio_bucket_private_tryon,
        purge_ttl_minutes=settings.tryon_purge_ttl_minutes,
        fal_key=settings.fal_key,
        fal_catvton_url=settings.fal_catvton_url,
        fal_timeout_seconds=settings.fal_timeout_seconds,
        hf_token=settings.hf_token,
        hf_vton_timeout_seconds=settings.hf_vton_timeout_seconds,
        hf_vton_enabled=settings.hf_vton_enabled,
    )
    normalizer = GarmentNormalizer()
    cache_quota = TryOnCacheQuota(
        redis_url=settings.redis_url,
        daily_limit=settings.tryon_daily_quota_per_user,
        guest_ip_limit=settings.tryon_daily_quota_guest_ip,
        auth_ip_limit=settings.tryon_daily_quota_auth_ip,
        cache_ttl_seconds=settings.tryon_cache_ttl_seconds,
    )
    worker_consumer = TryOnWorkerConsumer(
        rabbitmq_url=settings.rabbitmq_url,
        provider=provider,
        cache_quota=cache_quota,
        db=db,
        minio=minio,
        bff_url=settings.bff_internal_base_url,
        catalog_url=settings.catalog_service_url,
        internal_secret=settings.internal_service_secret,
        purge_ttl_minutes=settings.tryon_purge_ttl_minutes,
        presign_get_ttl_seconds=settings.tryon_presign_get_ttl_seconds,
    )
    auto_purge = TryOnAutoPurgeTask(
        db=db,
        minio=minio,
        cache_quota=cache_quota,
        private_bucket=settings.minio_bucket_private_tryon,
        ttl_minutes=settings.tryon_purge_ttl_minutes,
        interval_seconds=settings.tryon_purge_interval_seconds,
    )
    lookbook_studio = LookbookStudioService(
        minio=minio,
        catalog_url=settings.catalog_service_url,
        vton_provider=settings.vton_provider,
        fal_key=settings.fal_key,
        fal_endpoint_url=settings.fal_catvton_url,
        fal_timeout_seconds=settings.fal_timeout_seconds,
    )

    app.state.settings = settings
    app.state.db = db
    app.state.minio = minio
    app.state.provider = provider
    app.state.normalizer = normalizer
    app.state.cache_quota = cache_quota
    app.state.worker_consumer = worker_consumer
    app.state.auto_purge = auto_purge
    app.state.lookbook_studio = lookbook_studio


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    db: TryOnDatabase = app.state.db
    minio: MinioStorageClient = app.state.minio
    worker: TryOnWorkerConsumer = app.state.worker_consumer
    auto_purge: TryOnAutoPurgeTask = app.state.auto_purge
    cache_quota: TryOnCacheQuota = app.state.cache_quota

    await db.initialize()
    await seed_baseline_demand_signals(db)
    await minio.ensure_buckets()
    worker.start()
    if settings.tryon_enable_background_purge:
        auto_purge.start()
    try:
        yield
    finally:
        await auto_purge.stop()
        await worker.stop()
        await cache_quota.close()
        await db.close()


async def _probe_minio_health(endpoint_url: str) -> tuple[bool, int]:
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=0.75) as client:
            resp = await client.get(f"{endpoint_url.rstrip('/')}/minio/health/live")
            ok = resp.status_code == 200
    except Exception:
        ok = False
    return ok, max(0, int(round((time.perf_counter() - t0) * 1000)))


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or get_settings()
    application = FastAPI(
        title="Fashion Atelier AI Try-On Service",
        version=resolved_settings.service_version,
        description=(
            "Async Virtual Try-On (VTON) engine: privacy consent gate, strict Magic Bytes, "
            "dual Redis quota & SHA-256 cache, 1/2-step Pillow & fal.ai CatVTON compositing, "
            "Socket.io realtime progress, AI Lookbook Studio, and 15-minute MinIO auto-purge."
        ),
        lifespan=lifespan,
    )
    _attach_runtime_state(application, resolved_settings)

    application.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "https://localhost",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=[
            "*",
            CORRELATION_ID_HEADER,
            TRACEPARENT_HEADER,
        ],
        expose_headers=[
            CORRELATION_ID_HEADER,
            TRACEPARENT_HEADER,
        ],
    )

    @application.exception_handler(TryOnApiError)
    async def handle_tryon_api_error(
        request: Request,
        exc: TryOnApiError,
    ) -> Response:
        return build_api_error_response(
            status_code=exc.status_code,
            code=exc.code,
            message=exc.message,
            request=request,
            details=exc.details,
        )

    @application.exception_handler(RequestValidationError)
    async def handle_validation_error(
        request: Request,
        exc: RequestValidationError,
    ) -> Response:
        errors = exc.errors()
        if request.url.path.startswith("/v1/tryon") or request.url.path.startswith(
            "/internal/tryon"
        ):
            is_consent_err = any(
                "privacyConsent" in str(err.get("loc", ""))
                or "privacy_consent" in str(err.get("loc", ""))
                for err in errors
            )
            return build_api_error_response(
                status_code=400,
                code="PRIVACY_CONSENT_REQUIRED" if is_consent_err else "VALIDATION_ERROR",
                message=(
                    "privacyConsent=true is mandatory."
                    if is_consent_err
                    else "Invalid request payload."
                ),
                request=request,
                details={"issues": errors},
            )
        return build_api_error_response(
            status_code=422,
            code="VALIDATION_ERROR",
            message="Invalid request payload.",
            request=request,
            details={"issues": errors},
        )

    @application.middleware("http")
    async def correlation_and_trace_middleware(
        request: Request,
        call_next: Any,
    ) -> Response:
        t0 = time.perf_counter()
        incoming_corr = request.headers.get(CORRELATION_ID_HEADER)
        correlation_id = (
            incoming_corr.strip() if incoming_corr and incoming_corr.strip() else str(uuid4())
        )
        traceparent, trace_id, span_id = get_or_create_traceparent(
            request.headers.get(TRACEPARENT_HEADER)
        )
        request.state.correlation_id = correlation_id
        request.state.traceparent = traceparent
        request.state.trace_id = trace_id
        request.state.span_id = span_id

        response: Response = await call_next(request)
        response.headers[CORRELATION_ID_HEADER] = correlation_id
        response.headers[TRACEPARENT_HEADER] = traceparent

        elapsed_ms = int(round((time.perf_counter() - t0) * 1000))
        logger.info(
            "http_request method=%s path=%s status=%d latencyMs=%d correlationId=%s traceparent=%s",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
            correlation_id,
            traceparent,
        )
        return response

    @application.get("/health", tags=["system"])
    async def health(request: Request) -> dict[str, Any]:
        t0 = time.perf_counter()
        cfg: Settings = request.app.state.settings
        db: TryOnDatabase = request.app.state.db
        latency_ms = max(0, int(round((time.perf_counter() - t0) * 1000)))
        return {
            "status": "UP",
            "service": cfg.service_name,
            "version": cfg.service_version,
            "port": cfg.ai_tryon_port,
            "uptimeSeconds": max(0, int(time.monotonic() - PROCESS_STARTED_AT)),
            "latencyMs": latency_ms,
            "provider": cfg.vton_provider,
            "providerType": request.app.state.provider.provider_type,
            "database": db.db_name,
            "dbMode": db.db_mode,
            "correlationId": getattr(request.state, "correlation_id", ""),
            "traceparent": getattr(request.state, "traceparent", ""),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    @application.get("/ready", tags=["system"])
    async def ready(request: Request) -> dict[str, Any]:
        started = time.perf_counter()
        cfg: Settings = request.app.state.settings
        db: TryOnDatabase = request.app.state.db
        cache_quota: TryOnCacheQuota = request.app.state.cache_quota
        minio: MinioStorageClient = request.app.state.minio

        t_db = time.perf_counter()
        db_ok = await db.ping()
        db_latency_ms = max(0, int(round((time.perf_counter() - t_db) * 1000)))

        t_redis = time.perf_counter()
        redis_ok = await cache_quota.ping()
        redis_latency_ms = max(0, int(round((time.perf_counter() - t_redis) * 1000)))

        minio_ok, minio_latency_ms = await _probe_minio_health(minio.endpoint_url)
        provider_ok = await request.app.state.provider.health_check()

        worker: TryOnWorkerConsumer = request.app.state.worker_consumer
        purge: TryOnAutoPurgeTask = request.app.state.auto_purge

        total_latency_ms = max(0, int(round((time.perf_counter() - started) * 1000)))
        if not (db_ok and provider_ok):
            overall_status = "DOWN"
        elif not (redis_ok and minio_ok):
            overall_status = "DEGRADED"
        else:
            overall_status = "UP"

        return {
            "status": overall_status,
            "ready": bool(provider_ok and db_ok),
            "service": cfg.service_name,
            "version": cfg.service_version,
            "port": cfg.ai_tryon_port,
            "latencyMs": total_latency_ms,
            "provider": request.app.state.provider.name,
            "providerType": request.app.state.provider.provider_type,
            "database": db.db_name,
            "dbMode": db.db_mode,
            "checks": {
                "database": {
                    "name": db.db_name,
                    "isolated": db.db_name == "tryon_db",
                    "mode": db.db_mode,
                    "status": "up" if db_ok else "down",
                    "latencyMs": db_latency_ms,
                },
                "redis": {
                    "status": "up" if redis_ok else "degraded",
                    "mode": "redis" if redis_ok else "memory-fallback",
                    "latencyMs": redis_latency_ms,
                },
                "minio": {
                    "status": "up" if minio_ok else "degraded",
                    "endpoint": minio.endpoint_url,
                    "latencyMs": minio_latency_ms,
                },
                "vtonProvider": "ok" if provider_ok else "error",
                "preprocessing": "ok",
                "autoPurge": purge.status_summary(),
                "workerTopology": worker.topology.as_dict(),
            },
            "correlationId": getattr(request.state, "correlation_id", ""),
            "traceparent": getattr(request.state, "traceparent", ""),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    application.include_router(tryon_router)
    application.include_router(v1_router)
    application.include_router(internal_router)
    return application


app = create_app()


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    cfg = get_settings()
    uvicorn.run(
        "app.main:app",
        host=cfg.ai_tryon_host,
        port=cfg.ai_tryon_port,
        reload=False,
    )
