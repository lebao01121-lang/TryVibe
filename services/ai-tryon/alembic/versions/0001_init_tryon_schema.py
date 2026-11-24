"""Initialize 6 isolated tryon_db tables for Phase 4 Virtual Try-On engine.

Revision ID: 0001_init_tryon_schema
Revises:
Create Date: 2026-11-23 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0001_init_tryon_schema"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "temp_user_images",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("user_id", sa.String(length=64), nullable=True),
        sa.Column("guest_session_id", sa.String(length=128), nullable=True),
        sa.Column("ip_address", sa.String(length=64), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("minio_object_key", sa.String(length=512), nullable=False),
        sa.Column("sha256_hash", sa.String(length=128), nullable=False),
        sa.Column("pose_score", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column("privacy_consent", sa.Boolean(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("is_purged", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("purged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "idx_temp_user_images_purged_expires",
        "temp_user_images",
        ["is_purged", "expires_at"],
    )

    op.create_table(
        "tryon_sessions",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("user_id", sa.String(length=64), nullable=True),
        sa.Column("guest_session_id", sa.String(length=128), nullable=True),
        sa.Column(
            "temp_image_id",
            sa.String(length=64),
            sa.ForeignKey("temp_user_images.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("mode", sa.String(length=32), nullable=False),
        sa.Column("upper_product_id", sa.String(length=128), nullable=True),
        sa.Column("lower_product_id", sa.String(length=128), nullable=True),
        sa.Column("one_piece_product_id", sa.String(length=128), nullable=True),
        sa.Column("provider_used", sa.String(length=32), nullable=False, server_default="MOCK"),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="QUEUED"),
        sa.Column("progress_pct", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("step_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_steps", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("step_message", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("total_duration_ms", sa.Integer(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "tryon_jobs",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column(
            "session_id",
            sa.String(length=64),
            sa.ForeignKey("tryon_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("step_order", sa.Integer(), nullable=False),
        sa.Column("product_id", sa.String(length=128), nullable=False),
        sa.Column("garment_category", sa.String(length=32), nullable=False),
        sa.Column("cache_hash", sa.String(length=64), nullable=False),
        sa.Column("external_job_id", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="QUEUED"),
        sa.Column("estimated_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("api_latency_ms", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "tryon_results",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column(
            "session_id",
            sa.String(length=64),
            sa.ForeignKey("tryon_sessions.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("result_object_key", sa.String(length=512), nullable=False),
        sa.Column("is_purged", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("satisfaction_rating", sa.Integer(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "idx_tryon_results_purged_expires",
        "tryon_results",
        ["is_purged", "expires_at"],
    )

    op.create_table(
        "saved_tryon_looks",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("owner_key", sa.String(length=160), nullable=False),
        sa.Column(
            "session_id",
            sa.String(length=64),
            sa.ForeignKey("tryon_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("upper_sku_id", sa.String(length=128), nullable=True),
        sa.Column("lower_sku_id", sa.String(length=128), nullable=True),
        sa.Column("one_piece_sku_id", sa.String(length=128), nullable=True),
        sa.Column("result_object_key", sa.String(length=512), nullable=False),
        sa.Column("label", sa.String(length=160), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("idx_saved_tryon_looks_owner", "saved_tryon_looks", ["owner_key"])

    op.create_table(
        "tryon_demand_events",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("product_id", sa.String(length=128), nullable=False),
        sa.Column("sku_id", sa.String(length=128), nullable=True),
        sa.Column("session_id", sa.String(length=64), nullable=True),
        sa.Column("user_id", sa.String(length=64), nullable=True),
        sa.Column("signal_type", sa.String(length=48), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "idx_tryon_demand_product_signal_created",
        "tryon_demand_events",
        ["product_id", "signal_type", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_tryon_demand_product_signal_created", table_name="tryon_demand_events")
    op.drop_table("tryon_demand_events")
    op.drop_index("idx_saved_tryon_looks_owner", table_name="saved_tryon_looks")
    op.drop_table("saved_tryon_looks")
    op.drop_index("idx_tryon_results_purged_expires", table_name="tryon_results")
    op.drop_table("tryon_results")
    op.drop_table("tryon_jobs")
    op.drop_table("tryon_sessions")
    op.drop_index("idx_temp_user_images_purged_expires", table_name="temp_user_images")
    op.drop_table("temp_user_images")
