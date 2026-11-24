"""Add filtered partial index on temp_user_images (WHERE is_purged = false) for Phase 6 auto-purge.

Revision ID: 0003_phase6_unpurged_index
Revises: 0002_phase5_demand_signals
Create Date: 2026-11-23 16:15:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0003_phase6_unpurged_index"
down_revision: Union[str, Sequence[str], None] = "0002_phase5_demand_signals"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "idx_temp_user_images_unpurged_expires",
        "temp_user_images",
        ["expires_at"],
        unique=False,
        postgresql_where=sa.text("is_purged = false"),
        sqlite_where=sa.text("is_purged = 0"),
    )


def downgrade() -> None:
    op.drop_index("idx_temp_user_images_unpurged_expires", table_name="temp_user_images")
