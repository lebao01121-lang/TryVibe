from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    TypeDecorator,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UTCDateTime(TypeDecorator[datetime]):
    """Cross-engine UTC DateTime (timezone-aware on both PostgreSQL and SQLite)."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


class Base(DeclarativeBase):
    """Declarative base for all 6 isolated `tryon_db` tables."""


class TempUserImage(Base):
    __tablename__ = "temp_user_images"
    __table_args__ = (
        Index("idx_temp_user_images_purged_expires", "is_purged", "expires_at"),
        Index(
            "idx_temp_user_images_unpurged_expires",
            "expires_at",
            postgresql_where=text("is_purged = false"),
            sqlite_where=text("is_purged = 0"),
        ),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    guest_session_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    ip_address: Mapped[str] = mapped_column(String(64), nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    minio_object_key: Mapped[str] = mapped_column(String(512), nullable=False)
    sha256_hash: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    pose_score: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    privacy_consent: Mapped[bool] = mapped_column(Boolean, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    is_purged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    purged_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class TryOnSession(Base):
    __tablename__ = "tryon_sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    guest_session_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    temp_image_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("temp_user_images.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    mode: Mapped[str] = mapped_column(String(32), nullable=False)
    upper_product_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lower_product_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    one_piece_product_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    provider_used: Mapped[str] = mapped_column(String(32), nullable=False, default="SMART_POSE_WARP")
    provider_display_badge: Mapped[str | None] = mapped_column(String(96), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="QUEUED", index=True)
    progress_pct: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    step_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_steps: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    step_message: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    total_duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class TryOnJob(Base):
    __tablename__ = "tryon_jobs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("tryon_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    step_order: Mapped[int] = mapped_column(Integer, nullable=False)
    product_id: Mapped[str] = mapped_column(String(128), nullable=False)
    garment_category: Mapped[str] = mapped_column(String(32), nullable=False)
    cache_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    external_job_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="QUEUED")
    estimated_cost_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    api_latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class TryOnResult(Base):
    __tablename__ = "tryon_results"
    __table_args__ = (
        Index("idx_tryon_results_purged_expires", "is_purged", "expires_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("tryon_sessions.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    result_object_key: Mapped[str] = mapped_column(String(512), nullable=False)
    is_purged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    satisfaction_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class SavedTryOnLook(Base):
    __tablename__ = "saved_tryon_looks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_key: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    session_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("tryon_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    upper_sku_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lower_sku_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    one_piece_sku_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    result_object_key: Mapped[str] = mapped_column(String(512), nullable=False)
    label: Mapped[str | None] = mapped_column(String(160), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class TryOnDemandEvent(Base):
    __tablename__ = "tryon_demand_events"
    __table_args__ = (
        Index(
            "idx_tryon_demand_product_signal_created",
            "product_id",
            "signal_type",
            "created_at",
        ),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    product_id: Mapped[str] = mapped_column(String(128), nullable=False)
    sku_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    sku_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    size_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    session_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    signal_type: Mapped[str] = mapped_column(String(48), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
