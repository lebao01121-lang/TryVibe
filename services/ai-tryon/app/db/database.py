from __future__ import annotations

import logging
import socket
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.db.models import Base

logger = logging.getLogger("atelier.ai_tryon.db")

DbMode = Literal["postgres", "sqlite_local_harness"]


def assert_tryon_database_isolation(database_url: str) -> tuple[str, int, str]:
    """Assert `TRYON_DATABASE_URL` strictly targets isolated `tryon_db` only."""
    parsed = urlparse(database_url)
    db_name = parsed.path.lstrip("/").strip()
    if db_name != "tryon_db":
        raise RuntimeError(
            "Database-per-Service isolation violation: ai-tryon MUST ONLY connect to "
            f"'tryon_db', refused '{db_name or '<empty>'}'."
        )
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 5432
    return host, port, db_name


def is_tcp_reachable(host: str, port: int, timeout_seconds: float = 1.2) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout_seconds):
            return True
    except OSError:
        return False


def to_async_postgres_url(database_url: str) -> str:
    if database_url.startswith("postgresql+psycopg://"):
        return database_url
    if database_url.startswith("postgresql://"):
        return "postgresql+psycopg://" + database_url[len("postgresql://") :]
    if database_url.startswith("postgres://"):
        return "postgresql+psycopg://" + database_url[len("postgres://") :]
    return database_url


def to_async_sqlite_url(sqlite_path: str | Path) -> str:
    resolved = Path(sqlite_path).resolve()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite+aiosqlite:///{resolved.as_posix()}"


class TryOnDatabase:
    """Async SQLAlchemy 2.0 manager with automatic Postgres->SQLite local fallback."""

    def __init__(
        self,
        *,
        database_url: str,
        sqlite_path: str | Path,
        tcp_timeout_seconds: float = 1.2,
    ) -> None:
        self.configured_database_url = database_url
        self.sqlite_path = Path(sqlite_path)
        self.tcp_timeout_seconds = tcp_timeout_seconds

        self.pg_host, self.pg_port, self.db_name = assert_tryon_database_isolation(
            database_url
        )
        self.db_mode: DbMode = "sqlite_local_harness"
        self.active_url: str = ""
        self.engine: AsyncEngine | None = None
        self.session_factory: async_sessionmaker[AsyncSession] | None = None

    async def initialize(self) -> DbMode:
        if self.engine is not None:
            return self.db_mode

        pg_up = is_tcp_reachable(
            self.pg_host,
            self.pg_port,
            timeout_seconds=self.tcp_timeout_seconds,
        )
        if pg_up:
            try:
                pg_url = to_async_postgres_url(self.configured_database_url)
                engine = create_async_engine(
                    pg_url,
                    pool_pre_ping=True,
                    pool_size=5,
                    max_overflow=10,
                )
                async with engine.begin() as conn:
                    await conn.execute(text("SELECT 1"))
                    await conn.run_sync(Base.metadata.create_all)
                    await self._ensure_phase5_columns(conn, is_postgres=True)
                self.engine = engine
                self.db_mode = "postgres"
                self.active_url = pg_url
                self.session_factory = async_sessionmaker(
                    engine,
                    expire_on_commit=False,
                    class_=AsyncSession,
                )
                logger.info(
                    "Connected to isolated PostgreSQL tryon_db (%s:%d)",
                    self.pg_host,
                    self.pg_port,
                )
                return self.db_mode
            except Exception as exc:
                logger.warning(
                    "PostgreSQL %s:%d reachable but init failed (%s); falling back to local SQLite harness.",
                    self.pg_host,
                    self.pg_port,
                    exc.__class__.__name__,
                )

        sqlite_url = to_async_sqlite_url(self.sqlite_path)
        engine = create_async_engine(
            sqlite_url,
            connect_args={"timeout": 15},
        )

        @event.listens_for(engine.sync_engine, "connect")
        def _set_sqlite_pragmas(dbapi_conn: object, _connection_record: object) -> None:
            cursor = dbapi_conn.cursor()  # type: ignore[attr-defined]
            cursor.execute("PRAGMA foreign_keys=ON;")
            cursor.execute("PRAGMA journal_mode=WAL;")
            cursor.close()

        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await self._ensure_phase5_columns(conn, is_postgres=False)

        self.engine = engine
        self.db_mode = "sqlite_local_harness"
        self.active_url = sqlite_url
        self.session_factory = async_sessionmaker(
            engine,
            expire_on_commit=False,
            class_=AsyncSession,
        )
        logger.info(
            "Initialized isolated local SQLite tryon_db harness at %s",
            self.sqlite_path,
        )
        return self.db_mode

    async def _ensure_phase5_columns(self, conn: object, *, is_postgres: bool) -> None:
        """Idempotently ensure Phase 5 columns & Phase 6 filtered unpurged index."""
        if is_postgres:
            await conn.execute(  # type: ignore[attr-defined]
                text(
                    "ALTER TABLE tryon_demand_events "
                    "ADD COLUMN IF NOT EXISTS sku_code VARCHAR(64)"
                )
            )
            await conn.execute(  # type: ignore[attr-defined]
                text(
                    "ALTER TABLE tryon_demand_events "
                    "ADD COLUMN IF NOT EXISTS size_code VARCHAR(16)"
                )
            )
            await conn.execute(  # type: ignore[attr-defined]
                text(
                    "ALTER TABLE tryon_sessions "
                    "ADD COLUMN IF NOT EXISTS error_code VARCHAR(64)"
                )
            )
            await conn.execute(  # type: ignore[attr-defined]
                text(
                    "ALTER TABLE tryon_sessions "
                    "ADD COLUMN IF NOT EXISTS provider_display_badge VARCHAR(96)"
                )
            )
            await conn.execute(  # type: ignore[attr-defined]
                text(
                    "CREATE INDEX IF NOT EXISTS idx_temp_user_images_unpurged_expires "
                    "ON temp_user_images (expires_at) WHERE is_purged = false"
                )
            )
            return

        info_res = await conn.execute(text("PRAGMA table_info(tryon_demand_events)"))  # type: ignore[attr-defined]
        existing_cols = {str(row[1]) for row in info_res.fetchall()}
        if "sku_code" not in existing_cols:
            await conn.execute(  # type: ignore[attr-defined]
                text("ALTER TABLE tryon_demand_events ADD COLUMN sku_code VARCHAR(64)")
            )
        if "size_code" not in existing_cols:
            await conn.execute(  # type: ignore[attr-defined]
                text("ALTER TABLE tryon_demand_events ADD COLUMN size_code VARCHAR(16)")
            )
        sess_info_res = await conn.execute(text("PRAGMA table_info(tryon_sessions)"))  # type: ignore[attr-defined]
        sess_cols = {str(row[1]) for row in sess_info_res.fetchall()}
        if "error_code" not in sess_cols:
            await conn.execute(  # type: ignore[attr-defined]
                text("ALTER TABLE tryon_sessions ADD COLUMN error_code VARCHAR(64)")
            )
        if "provider_display_badge" not in sess_cols:
            await conn.execute(  # type: ignore[attr-defined]
                text("ALTER TABLE tryon_sessions ADD COLUMN provider_display_badge VARCHAR(96)")
            )
        await conn.execute(  # type: ignore[attr-defined]
            text(
                "CREATE INDEX IF NOT EXISTS idx_temp_user_images_unpurged_expires "
                "ON temp_user_images (expires_at) WHERE is_purged = 0"
            )
        )

    def session(self) -> AsyncSession:
        if self.session_factory is None:
            raise RuntimeError("TryOnDatabase.initialize() must be called before opening a session.")
        return self.session_factory()

    async def ping(self) -> bool:
        if self.engine is None:
            return False
        try:
            async with self.engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            return True
        except Exception:
            return False

    async def close(self) -> None:
        if self.engine is not None:
            await self.engine.dispose()
            self.engine = None
            self.session_factory = None
