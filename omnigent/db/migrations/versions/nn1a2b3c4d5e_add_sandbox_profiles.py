"""Add workspace-scoped immutable sandbox profile references.

Revision ID: nn1a2b3c4d5e
Revises: b2e4f6a8c013
Create Date: 2026-10-12 00:00:00.000000

Deploy this additive schema before the profile API. Older servers ignore the
table, so application rollback preserves accepted references.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision: str = "nn1a2b3c4d5e"
down_revision: str | None = "b2e4f6a8c013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sandbox_profile_bindings",
        sa.Column("workspace_id", sa.BigInteger(), primary_key=True),
        sa.Column("session_id", Uuid16(), primary_key=True),
        sa.Column("host_id", Uuid16(), nullable=True),
        sa.Column("snapshot_json", sa.LargeBinary(16383), nullable=False),
        sa.CheckConstraint(
            sa.func.length(sa.cast(sa.column("snapshot_json"), sa.LargeBinary)) <= 16383,
            name="ck_sandbox_profile_bindings_snapshot_bytes",
        ),
    )
    op.create_index(
        "ix_sandbox_profile_bindings_host",
        "sandbox_profile_bindings",
        ["workspace_id", "host_id", "session_id"],
    )
    op.create_index(
        "ix_conversation_metadata_runner_host",
        "omnigent_conversation_metadata",
        ["workspace_id", "runner_id", "host_id", "id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_conversation_metadata_runner_host", table_name="omnigent_conversation_metadata"
    )
    op.drop_table("sandbox_profile_bindings")
