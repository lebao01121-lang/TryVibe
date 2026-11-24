from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]
ROOT_ENV_PATH = REPO_ROOT / ".env"


class Settings(BaseSettings):
    """Runtime configuration loaded from workspace root `.env`."""

    model_config = SettingsConfigDict(
        env_file=str(ROOT_ENV_PATH),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    service_name: str = "ai-tryon"
    service_version: str = "3.1.0"
    app_env: str = Field(
        default="development",
        validation_alias=AliasChoices("APP_ENV", "NODE_ENV"),
    )

    ai_tryon_host: str = Field(default="0.0.0.0", validation_alias="AI_TRYON_HOST")
    ai_tryon_port: int = Field(default=4009, validation_alias="AI_TRYON_PORT")

    tryon_database_url: str = Field(
        default="postgresql://svc_tryon:Atelier_TryOn2026!@127.0.0.1:5432/tryon_db",
        validation_alias="TRYON_DATABASE_URL",
    )
    tryon_sqlite_path: str = Field(
        default=str(REPO_ROOT / ".local-pgdata" / "tryon_db.sqlite"),
        validation_alias="TRYON_SQLITE_PATH",
    )

    bff_url: str = Field(
        default="http://127.0.0.1:4000",
        validation_alias=AliasChoices("BFF_URL", "NEXT_PUBLIC_BFF_URL"),
    )
    catalog_service_url: str = Field(
        default="http://127.0.0.1:4002",
        validation_alias="CATALOG_SERVICE_URL",
    )
    internal_service_secret: str = Field(
        default="Atelier_Internal_Svc_2026!",
        validation_alias="INTERNAL_SERVICE_SECRET",
    )

    minio_endpoint: str = Field(
        default="127.0.0.1",
        validation_alias="MINIO_ENDPOINT",
    )
    minio_port: int = Field(default=9000, validation_alias="MINIO_PORT")
    minio_use_ssl: bool = Field(default=False, validation_alias="MINIO_USE_SSL")
    minio_public_url: str | None = Field(
        default=None,
        validation_alias="MINIO_PUBLIC_URL",
    )
    minio_access_key: str = Field(
        default="atelier_minio",
        validation_alias=AliasChoices("MINIO_ACCESS_KEY", "MINIO_ROOT_USER"),
    )
    minio_secret_key: str = Field(
        default="Atelier_Minio2026!",
        validation_alias=AliasChoices("MINIO_SECRET_KEY", "MINIO_ROOT_PASSWORD"),
    )
    minio_region: str = Field(default="us-east-1", validation_alias="MINIO_REGION")
    minio_bucket_public: str = Field(
        default="atelier-public",
        validation_alias="MINIO_BUCKET_PUBLIC",
    )
    minio_bucket_garments: str = Field(
        default="atelier-garments",
        validation_alias="MINIO_BUCKET_GARMENTS",
    )
    minio_bucket_private_tryon: str = Field(
        default="atelier-private-tryon",
        validation_alias=AliasChoices(
            "MINIO_BUCKET_PRIVATE_TRYON",
            "MINIO_BUCKET_TRYON",
        ),
    )

    rabbitmq_url: str = Field(
        default="amqp://atelier_mq:Atelier_Mq2026!@127.0.0.1:5672",
        validation_alias="RABBITMQ_URL",
    )
    redis_url: str = Field(
        default="redis://:Atelier_Redis2026!@127.0.0.1:6379",
        validation_alias="REDIS_URL",
    )

    # 3-Tier VTON Provider Configuration (default: auto -> Fal -> HF Gradio -> SmartPoseWarp)
    vton_provider: str = Field(
        default="auto",
        validation_alias=AliasChoices(
            "TRYON_PROVIDER",
            "VTON_PROVIDER",
            "tryon_provider",
            "vton_provider",
        ),
    )
    fal_key: str = Field(default="", validation_alias="FAL_KEY")
    fal_catvton_url: str = Field(
        default="https://queue.fal.run/fal-ai/cat-vton",
        validation_alias="FAL_CATVTON_URL",
    )
    fal_timeout_seconds: float = Field(
        default=45.0,
        validation_alias="FAL_TIMEOUT_SECONDS",
        ge=5.0,
        le=120.0,
    )
    hf_token: str = Field(default="", validation_alias="HF_TOKEN")
    hf_vton_timeout_seconds: float = Field(
        default=40.0,
        validation_alias="HF_VTON_TIMEOUT_SECONDS",
        ge=5.0,
        le=180.0,
    )
    hf_vton_enabled: bool = Field(
        default=True,
        validation_alias="HF_VTON_ENABLED",
    )

    tryon_purge_ttl_minutes: int = Field(
        default=15,
        validation_alias="TRYON_PURGE_TTL_MINUTES",
        ge=1,
        le=1440,
    )
    tryon_purge_interval_seconds: int = Field(
        default=60,
        validation_alias="TRYON_PURGE_INTERVAL_SECONDS",
        ge=10,
        le=3600,
    )
    tryon_presign_put_ttl_seconds: int = Field(
        default=180,
        validation_alias="TRYON_PRESIGN_PUT_TTL_SECONDS",
        ge=30,
        le=900,
    )
    tryon_presign_get_ttl_seconds: int = Field(
        default=900,
        validation_alias="TRYON_PRESIGN_GET_TTL_SECONDS",
        ge=60,
        le=3600,
    )
    tryon_daily_quota_per_user: int = Field(
        default=10,
        validation_alias="TRYON_DAILY_QUOTA_PER_USER",
        ge=1,
        le=500,
    )
    tryon_daily_quota_guest_ip: int = Field(
        default=5,
        validation_alias="TRYON_DAILY_QUOTA_GUEST_IP",
        ge=1,
        le=500,
    )
    tryon_daily_quota_auth_ip: int = Field(
        default=30,
        validation_alias="TRYON_DAILY_QUOTA_AUTH_IP",
        ge=1,
        le=1000,
    )
    tryon_cache_ttl_seconds: int = Field(
        default=900,
        validation_alias="TRYON_CACHE_TTL_SECONDS",
        ge=60,
    )
    tryon_max_bookmarks: int = Field(
        default=3,
        validation_alias="TRYON_MAX_BOOKMARKS",
        ge=1,
        le=20,
    )
    tryon_enable_background_purge: bool = Field(
        default=True,
        validation_alias="TRYON_ENABLE_BACKGROUND_PURGE",
    )

    @property
    def tryon_provider(self) -> str:
        return self.vton_provider

    @property
    def minio_endpoint_url(self) -> str:
        """Return a normalized scheme+host+port URL suitable for boto3 S3 client."""
        raw = self.minio_endpoint.strip()
        if raw.startswith("http://") or raw.startswith("https://"):
            return raw.rstrip("/")
        if self.minio_public_url and (
            self.minio_public_url.startswith("http://")
            or self.minio_public_url.startswith("https://")
        ):
            return self.minio_public_url.rstrip("/")
        scheme = "https" if self.minio_use_ssl else "http"
        return f"{scheme}://{raw}:{self.minio_port}"

    @property
    def bff_internal_base_url(self) -> str:
        raw = (self.bff_url or "http://127.0.0.1:4000").strip().rstrip("/")
        return raw.replace("http://localhost:", "http://127.0.0.1:")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
