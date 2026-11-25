from __future__ import annotations

import os
import tempfile
from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]
ROOT_ENV_PATH = REPO_ROOT / ".env"

DEFAULT_TRYON_TMP_DIR = REPO_ROOT / ".project-data" / "tmp"
DEFAULT_TRYON_MODELS_DIR = REPO_ROOT / ".project-data" / "ai-models"
DEFAULT_UV_CACHE_DIR = REPO_ROOT / ".project-data" / "uv-cache"


def bootstrap_d_drive_environment(
    tmp_dir: str | Path | None = None,
    models_dir: str | Path | None = None,
) -> tuple[Path, Path]:
    """
    Strictly isolate 100% of temporary files, Gradio downloads, HuggingFace cache,
    U2NET/rembg ONNX weights, PyTorch cache, and Matplotlib config onto D: drive
    (`D:\\doancosothue\\TryVibe\\.project-data\\...`).
    NEVER allow spills into `C:\\Users\\...\\AppData\\Local\\Temp`.
    """
    resolved_tmp = Path(
        tmp_dir or os.environ.get("TRYON_TMP_DIR") or DEFAULT_TRYON_TMP_DIR
    ).resolve()
    resolved_models = Path(
        models_dir or os.environ.get("TRYON_MODELS_DIR") or DEFAULT_TRYON_MODELS_DIR
    ).resolve()

    hf_dir = resolved_models / "huggingface"
    u2net_dir = resolved_models / "u2net"
    torch_dir = resolved_models / "torch"
    cache_dir = resolved_models / "cache"
    mpl_dir = resolved_tmp / "mpl"

    for directory in (
        resolved_tmp,
        resolved_models,
        hf_dir,
        u2net_dir,
        torch_dir,
        cache_dir,
        mpl_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)

    tmp_str = str(resolved_tmp)
    # Force all process-level temp & AI model env vars onto D: drive
    os.environ["TMP"] = tmp_str
    os.environ["TEMP"] = tmp_str
    os.environ["TMPDIR"] = tmp_str
    os.environ["GRADIO_TEMP_DIR"] = tmp_str
    os.environ["HF_HOME"] = str(hf_dir)
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(hf_dir / "hub")
    os.environ["U2NET_HOME"] = str(u2net_dir)
    os.environ["REMBG_HOME"] = str(u2net_dir)
    os.environ["TORCH_HOME"] = str(torch_dir)
    os.environ["MPLCONFIGDIR"] = str(mpl_dir)
    os.environ["XDG_CACHE_HOME"] = str(cache_dir)
    os.environ.setdefault("UV_CACHE_DIR", str(DEFAULT_UV_CACHE_DIR))

    # Override Python tempfile module cache so NamedTemporaryFile / TemporaryDirectory use D:
    tempfile.tempdir = tmp_str

    return resolved_tmp, resolved_models


# Execute bootstrap immediately at import time before gradio_client / rembg / PIL touch tempdir
bootstrap_d_drive_environment()


class Settings(BaseSettings):
    """Runtime configuration loaded from workspace root `.env`."""

    model_config = SettingsConfigDict(
        env_file=str(ROOT_ENV_PATH),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    service_name: str = "ai-tryon"
    service_version: str = "3.2.0"
    app_env: str = Field(
        default="development",
        validation_alias=AliasChoices("APP_ENV", "NODE_ENV"),
    )
    infra_mode: str = Field(default="", validation_alias="INFRA_MODE")

    ai_tryon_host: str = Field(default="0.0.0.0", validation_alias="AI_TRYON_HOST")
    ai_tryon_port: int = Field(default=4009, validation_alias="AI_TRYON_PORT")

    postgres_host: str = Field(default="127.0.0.1", validation_alias="POSTGRES_HOST")
    postgres_port: int = Field(default=5432, validation_alias="POSTGRES_PORT")
    tryon_db_user: str = Field(default="svc_tryon", validation_alias="TRYON_DB_USER")
    tryon_db_password: str = Field(
        default="Atelier_TryOn2026!",
        validation_alias="TRYON_DB_PASSWORD",
    )
    tryon_db_name: str = Field(default="tryon_db", validation_alias="TRYON_DB_NAME")
    database_url: str | None = Field(default=None, validation_alias="DATABASE_URL")

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

    # D: Drive Strict Storage Isolation
    tryon_tmp_dir: str = Field(
        default=str(DEFAULT_TRYON_TMP_DIR),
        validation_alias="TRYON_TMP_DIR",
    )
    tryon_models_dir: str = Field(
        default=str(DEFAULT_TRYON_MODELS_DIR),
        validation_alias="TRYON_MODELS_DIR",
    )

    # 4-Tier VTON Provider Configuration (auto -> Fal/Fashn -> LAN GPU -> HF ZeroGPU -> PhotometricInpaint)
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
    fal_vton_model: str = Field(
        default="fal-ai/cat-vton",
        validation_alias="FAL_VTON_MODEL",
    )
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

    fashn_api_key: str = Field(default="", validation_alias="FASHN_API_KEY")
    fashn_api_url: str = Field(
        default="https://api.fashn.ai/v1/run",
        validation_alias="FASHN_API_URL",
    )

    hf_token: str = Field(default="", validation_alias="HF_TOKEN")
    hf_vton_enabled: bool = Field(
        default=True,
        validation_alias="HF_VTON_ENABLED",
    )
    hf_vton_timeout_seconds: float = Field(
        default=28.0,
        validation_alias="HF_VTON_TIMEOUT_SECONDS",
        ge=5.0,
        le=180.0,
    )

    local_vton_endpoint: str = Field(
        default="",
        validation_alias="LOCAL_VTON_ENDPOINT",
    )

    tryon_total_timeout_seconds: float = Field(
        default=45.0,
        validation_alias="TRYON_TOTAL_TIMEOUT_SECONDS",
        ge=10.0,
        le=180.0,
    )
    tryon_circuit_breaker_seconds: int = Field(
        default=180,
        validation_alias="TRYON_CIRCUIT_BREAKER_SECONDS",
        ge=15,
        le=3600,
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

    def model_post_init(self, __context: object) -> None:
        bootstrap_d_drive_environment(
            tmp_dir=self.tryon_tmp_dir,
            models_dir=self.tryon_models_dir,
        )

    @property
    def resolved_tryon_database_url(self) -> str:
        """
        Prioritize PostgreSQL `tryon_db` from TRYON_DATABASE_URL, then DATABASE_URL (only if
        targeting isolated `tryon_db`), then assembled from POSTGRES_HOST:POSTGRES_PORT.
        """
        explicit_tryon = (os.environ.get("TRYON_DATABASE_URL") or "").strip()
        if explicit_tryon:
            return explicit_tryon

        configured = (self.tryon_database_url or "").strip()
        default_url = "postgresql://svc_tryon:Atelier_TryOn2026!@127.0.0.1:5432/tryon_db"
        if configured and configured != default_url:
            return configured

        generic = (self.database_url or "").strip()
        if generic and generic.startswith(("postgresql://", "postgres://", "postgresql+")) and generic.rstrip("/").endswith("/tryon_db"):
            return generic

        host = (self.postgres_host or "127.0.0.1").strip()
        port = int(self.postgres_port or 5432)
        user = (self.tryon_db_user or "svc_tryon").strip()
        pwd = self.tryon_db_password or "Atelier_TryOn2026!"
        db_name = (self.tryon_db_name or "tryon_db").strip() or "tryon_db"
        return f"postgresql://{user}:{pwd}@{host}:{port}/{db_name}"

    @property
    def tryon_provider(self) -> str:
        return self.vton_provider

    @property
    def resolved_fal_endpoint_url(self) -> str:
        """Build `https://queue.fal.run/{fal_vton_model}` unless a custom URL is explicitly set."""
        model = (self.fal_vton_model or "fal-ai/cat-vton").strip().lstrip("/")
        raw_url = (self.fal_catvton_url or "").strip()
        if raw_url and raw_url != "https://queue.fal.run/fal-ai/cat-vton":
            return raw_url
        return f"https://queue.fal.run/{model}"

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
    settings = Settings()
    bootstrap_d_drive_environment(
        tmp_dir=settings.tryon_tmp_dir,
        models_dir=settings.tryon_models_dir,
    )
    return settings
