"""Add sku_code and size_code columns to tryon_demand_events for Phase 5 demand analytics.

Revision ID: 0002_phase5_demand_signals
Revises: 0001_init_tryon_schema
Create Date: 2026-11-23 15:35:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0002_phase5_demand_signals"
down_revision: Union[str, Sequence[str], None] = "0001_init_tryon_schema"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("tryon_demand_events") as batch_op:
        batch_op.add_column(sa.Column("sku_code", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("size_code", sa.String(length=16), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("tryon_demand_events") as batch_op:
        batch_op.drop_column("size_code")
        batch_op.drop_column("sku_code")
