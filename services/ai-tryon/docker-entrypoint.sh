#!/usr/bin/env sh
set -eu

# -----------------------------------------------------------------------------
# Load Docker Secrets from *_FILE paths (zero hardcoded default passwords!)
# -----------------------------------------------------------------------------
read_secret() {
  var_name="$1"
  file_var="${var_name}_FILE"
  eval "file_path=\${$file_var:-}"
  if [ -n "$file_path" ] && [ -f "$file_path" ]; then
    val="$(tr -d '\r\n' < "$file_path")"
    export "$var_name=$val"
  fi
}

read_secret POSTGRES_PASSWORD
read_secret TRYON_DB_PASSWORD
read_secret REDIS_PASSWORD
read_secret RABBITMQ_PASSWORD
read_secret MINIO_SECRET_KEY
read_secret INTERNAL_SERVICE_SECRET

# Assemble connection URLs from secret-backed credentials when not explicitly set
if [ -z "${TRYON_DATABASE_URL:-}" ] && [ -n "${TRYON_DB_PASSWORD:-}" ]; then
  PG_HOST="${POSTGRES_HOST:-atelier-postgres}"
  PG_PORT="${POSTGRES_PORT:-5432}"
  PG_USER="${TRYON_DB_USER:-svc_tryon}"
  PG_DB="${TRYON_DB_NAME:-tryon_db}"
  export TRYON_DATABASE_URL="postgresql://${PG_USER}:${TRYON_DB_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB}"
fi

if [ -z "${REDIS_URL:-}" ] && [ -n "${REDIS_PASSWORD:-}" ]; then
  R_HOST="${REDIS_HOST:-atelier-redis}"
  R_PORT="${REDIS_PORT:-6379}"
  export REDIS_URL="redis://:${REDIS_PASSWORD}@${R_HOST}:${R_PORT}/0"
fi

if [ -z "${RABBITMQ_URL:-}" ] && [ -n "${RABBITMQ_PASSWORD:-}" ]; then
  MQ_HOST="${RABBITMQ_HOST:-atelier-rabbitmq}"
  MQ_PORT="${RABBITMQ_PORT:-5672}"
  MQ_USER="${RABBITMQ_USER:-atelier_mq}"
  export RABBITMQ_URL="amqp://${MQ_USER}:${RABBITMQ_PASSWORD}@${MQ_HOST}:${MQ_PORT}/"
fi

ROLE="$(printf '%s' "${TRYON_ROLE:-all}" | tr '[:upper:]' '[:lower:]')"
HOST="${AI_TRYON_HOST:-0.0.0.0}"
PORT="${AI_TRYON_PORT:-4009}"

case "$ROLE" in
  api)
    echo "[ai-tryon] Starting FastAPI API role on ${HOST}:${PORT}"
    export TRYON_ENABLE_BACKGROUND_PURGE="${TRYON_ENABLE_BACKGROUND_PURGE:-false}"
    exec uvicorn app.main:app --host "$HOST" --port "$PORT" --proxy-headers --forwarded-allow-ips='*'
    ;;

  worker)
    echo "[ai-tryon] Starting standalone RabbitMQ VTON consumer + 15-min auto-purge worker role"
    exec python - <<'PYEOF'
import asyncio
import logging
import signal
from pathlib import Path

from app.cache_quota.quota import TryOnCacheQuota
from app.config import get_settings
from app.db.database import TryOnDatabase
from app.providers.mock_provider import get_vton_provider
from app.storage.minio_client import MinioStorageClient
from app.tasks.auto_purge import TryOnAutoPurgeTask
from app.workers.consumer import TryOnWorkerConsumer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("atelier.ai_tryon.worker_entrypoint")
HEARTBEAT_FILE = Path("/tmp/tryon-worker.alive")


async def run_worker() -> None:
    cfg = get_settings()
    db = TryOnDatabase(
        database_url=cfg.resolved_tryon_database_url,
        sqlite_path=cfg.tryon_sqlite_path,
        infra_mode=cfg.infra_mode,
    )
    minio = MinioStorageClient(
        endpoint_url=cfg.minio_endpoint_url,
        access_key=cfg.minio_access_key,
        secret_key=cfg.minio_secret_key,
        region=cfg.minio_region,
        private_bucket=cfg.minio_bucket_private_tryon,
        garments_bucket=cfg.minio_bucket_garments,
        public_bucket=cfg.minio_bucket_public,
    )
    provider = get_vton_provider(
        cfg.vton_provider,
        private_bucket=cfg.minio_bucket_private_tryon,
        purge_ttl_minutes=cfg.tryon_purge_ttl_minutes,
        fal_key=cfg.fal_key,
        fal_vton_model=cfg.fal_vton_model,
        fal_catvton_url=cfg.resolved_fal_endpoint_url,
        fal_timeout_seconds=cfg.fal_timeout_seconds,
        fashn_api_key=cfg.fashn_api_key,
        fashn_api_url=cfg.fashn_api_url,
        hf_token=cfg.hf_token,
        hf_vton_timeout_seconds=cfg.hf_vton_timeout_seconds,
        hf_vton_enabled=cfg.hf_vton_enabled,
        local_vton_endpoint=cfg.local_vton_endpoint,
        total_timeout_seconds=cfg.tryon_total_timeout_seconds,
        circuit_breaker_seconds=cfg.tryon_circuit_breaker_seconds,
        tmp_dir=cfg.tryon_tmp_dir,
    )
    cache_quota = TryOnCacheQuota(
        redis_url=cfg.redis_url,
        daily_limit=cfg.tryon_daily_quota_per_user,
        guest_ip_limit=cfg.tryon_daily_quota_guest_ip,
        auth_ip_limit=cfg.tryon_daily_quota_auth_ip,
        cache_ttl_seconds=cfg.tryon_cache_ttl_seconds,
        is_production=(cfg.app_env.strip().lower() == "production"),
    )
    worker = TryOnWorkerConsumer(
        rabbitmq_url=cfg.rabbitmq_url,
        provider=provider,
        cache_quota=cache_quota,
        db=db,
        minio=minio,
        bff_url=cfg.bff_internal_base_url,
        catalog_url=cfg.catalog_service_url,
        internal_secret=cfg.internal_service_secret,
        purge_ttl_minutes=cfg.tryon_purge_ttl_minutes,
        presign_get_ttl_seconds=cfg.tryon_presign_get_ttl_seconds,
    )
    auto_purge = TryOnAutoPurgeTask(
        db=db,
        minio=minio,
        cache_quota=cache_quota,
        private_bucket=cfg.minio_bucket_private_tryon,
        ttl_minutes=cfg.tryon_purge_ttl_minutes,
        interval_seconds=cfg.tryon_purge_interval_seconds,
    )

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass

    await db.initialize()
    await minio.ensure_buckets()
    await worker.start()
    auto_purge.start()
    logger.info(
        "Standalone AI Try-On worker active (transport=%s, autoPurgeTTL=%dm)",
        worker.worker_transport,
        cfg.tryon_purge_ttl_minutes,
    )

    try:
        while not stop_event.is_set():
            HEARTBEAT_FILE.write_text("ok\n", encoding="utf-8")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=15.0)
            except asyncio.TimeoutError:
                pass
    finally:
        logger.info("Shutting down standalone AI Try-On worker...")
        await auto_purge.stop()
        await worker.stop()
        await cache_quota.close()
        await db.close()
        HEARTBEAT_FILE.unlink(missing_ok=True)


asyncio.run(run_worker())
PYEOF
    ;;

  all)
    echo "[ai-tryon] Starting combined API + RabbitMQ worker + auto-purge role on ${HOST}:${PORT}"
    export TRYON_ENABLE_BACKGROUND_PURGE="${TRYON_ENABLE_BACKGROUND_PURGE:-true}"
    exec uvicorn app.main:app --host "$HOST" --port "$PORT" --proxy-headers --forwarded-allow-ips='*'
    ;;

  *)
    echo "[ai-tryon] ERROR: Invalid TRYON_ROLE='$ROLE' (expected: api | worker | all)" >&2
    exit 64
    ;;
esac
