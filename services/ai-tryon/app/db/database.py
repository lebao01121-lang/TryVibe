from __future__ import annotations

import asyncio
import importlib.util
import logging
import socket
import sys
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import Session, sessionmaker

from app.db.models import Base

logger = logging.getLogger("atelier.ai_tryon.db")

DbMode = Literal["postgres", "sqlite_local_harness"]
DatabaseDialect = Literal["postgresql", "sqlite"]


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


def _has_module(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def _is_windows_proactor_loop() -> bool:
    if sys.platform != "win32":
        return False
    try:
        loop = asyncio.get_running_loop()
        return isinstance(loop, asyncio.ProactorEventLoop)
    except RuntimeError:
        return False


def to_async_postgres_url(database_url: str, *, prefer_asyncpg: bool = False) -> str:
    driver = "asyncpg" if (prefer_asyncpg and _has_module("asyncpg")) else "psycopg"
    for prefix in (
        "postgresql+asyncpg://",
        "postgresql+psycopg://",
        "postgresql+psycopg2://",
        "postgresql://",
        "postgres://",
    ):
        if database_url.startswith(prefix):
            return f"postgresql+{driver}://" + database_url[len(prefix) :]
    return database_url


def to_sync_postgres_url(database_url: str) -> str:
    driver = "psycopg" if _has_module("psycopg") else "psycopg2"
    for prefix in (
        "postgresql+asyncpg://",
        "postgresql+psycopg://",
        "postgresql+psycopg2://",
        "postgresql://",
        "postgres://",
    ):
        if database_url.startswith(prefix):
            return f"postgresql+{driver}://" + database_url[len(prefix) :]
    return database_url


def to_async_sqlite_url(sqlite_path: str | Path) -> str:
    resolved = Path(sqlite_path).resolve()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite+aiosqlite:///{resolved.as_posix()}"


class _ThreadedAsyncSession:
    """
    AsyncSession-compatible wrapper over a synchronous SQLAlchemy psycopg3 Session.
    Used ONLY on Windows ProactorEventLoop (e.g., uvicorn default loop) when `asyncpg`
    is not installed, because `psycopg` async refuses ProactorEventLoop while sync
    `psycopg` works natively with PostgreSQL 16.
    """

    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory
        self._sync_session: Session | None = None
        self._lock = asyncio.Lock()

    def _ensure_sync(self) -> Session:
        if self._sync_session is None:
            self._sync_session = self._session_factory()
        return self._sync_session

    async def __aenter__(self) -> _ThreadedAsyncSession:
        await asyncio.to_thread(self._ensure_sync)
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if exc_type is not None:
            await self.rollback()
        await self.close()

    def add(self, instance: object) -> None:
        self._ensure_sync().add(instance)

    def add_all(self, instances: Any) -> None:
        self._ensure_sync().add_all(instances)

    async def get(self, entity: Any, ident: Any, **kwargs: Any) -> Any:
        async with self._lock:
            sess = self._ensure_sync()
            return await asyncio.to_thread(sess.get, entity, ident, **kwargs)

    async def execute(self, statement: Any, params: Any = None, **kwargs: Any) -> Any:
        async with self._lock:
            sess = self._ensure_sync()
            if params is None:
                return await asyncio.to_thread(sess.execute, statement, **kwargs)
            return await asyncio.to_thread(sess.execute, statement, params, **kwargs)

    async def delete(self, instance: object) -> None:
        async with self._lock:
            sess = self._ensure_sync()
            await asyncio.to_thread(sess.delete, instance)

    async def flush(self, objects: Any = None) -> None:
        async with self._lock:
            sess = self._ensure_sync()
            await asyncio.to_thread(sess.flush, objects)

    async def commit(self) -> None:
        async with self._lock:
            sess = self._ensure_sync()
            await asyncio.to_thread(sess.commit)

    async def rollback(self) -> None:
        async with self._lock:
            if self._sync_session is not None:
                await asyncio.to_thread(self._sync_session.rollback)

    async def refresh(self, instance: object, **kwargs: Any) -> None:
        async with self._lock:
            sess = self._ensure_sync()
            await asyncio.to_thread(sess.refresh, instance, **kwargs)

    async def close(self) -> None:
        async with self._lock:
            if self._sync_session is not None:
                sess = self._sync_session
                self._sync_session = None
                await asyncio.to_thread(sess.close)


class TryOnDatabase:
    """Async SQLAlchemy 2.0 manager prioritizing PostgreSQL `tryon_db` with clean SQLite fallback."""

    def __init__(
        self,
        *,
        database_url: str,
        sqlite_path: str | Path,
        tcp_timeout_seconds: float = 1.5,
        infra_mode: str = "",
    ) -> None:
        self.configured_database_url = database_url
        self.sqlite_path = Path(sqlite_path)
        self.tcp_timeout_seconds = tcp_timeout_seconds
        self.infra_mode = (infra_mode or "").strip().upper()

        self.pg_host, self.pg_port, self.db_name = assert_tryon_database_isolation(
            database_url
        )
        self.db_mode: DbMode = "sqlite_local_harness"
        self.active_url: str = ""
        self.fallback_reason: str | None = None
        self.engine: AsyncEngine | None = None
        self.session_factory: async_sessionmaker[AsyncSession] | None = None
        self._sync_pg_engine: Engine | None = None
        self._sync_pg_session_factory: sessionmaker[Session] | None = None

    @property
    def database_dialect(self) -> DatabaseDialect:
        return "postgresql" if self.db_mode == "postgres" else "sqlite"

    async def _init_postgres_async(self, *, prefer_asyncpg: bool) -> bool:
        pg_url = to_async_postgres_url(
            self.configured_database_url,
            prefer_asyncpg=prefer_asyncpg,
        )
        engine = create_async_engine(
            pg_url,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10,
        )
        try:
            async with engine.begin() as conn:
                await conn.execute(text("SELECT 1"))
                await conn.run_sync(Base.metadata.create_all)
                await self._ensure_phase5_columns(conn, is_postgres=True)
            self.engine = engine
            self.db_mode = "postgres"
            self.active_url = pg_url
            self.fallback_reason = None
            self.session_factory = async_sessionmaker(
                engine,
                expire_on_commit=False,
                class_=AsyncSession,
            )
            logger.info(
                "Database dialect=postgresql connected (async) to isolated tryon_db (%s:%d)",
                self.pg_host,
                self.pg_port,
            )
            return True
        except Exception:
            await engine.dispose()
            raise

    def _init_postgres_sync_threaded(self) -> tuple[Engine, sessionmaker[Session], str]:
        pg_url = to_sync_postgres_url(self.configured_database_url)
        sync_engine = create_engine(
            pg_url,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10,
            connect_args={"connect_timeout": 3},
        )
        try:
            with sync_engine.begin() as conn:
                conn.execute(text("SELECT 1"))
                Base.metadata.create_all(bind=conn)
                self._ensure_phase5_columns_sync(conn)
            factory = sessionmaker(
                bind=sync_engine,
                expire_on_commit=False,
                class_=Session,
            )
            return sync_engine, factory, pg_url
        except Exception:
            sync_engine.dispose()
            raise

    async def initialize(self) -> DbMode:
        if self.engine is not None or self._sync_pg_engine is not None:
            return self.db_mode

        pg_configured = self.configured_database_url.startswith(
            ("postgresql://", "postgres://", "postgresql+")
        )
        if pg_configured:
            pg_up = await asyncio.to_thread(
                is_tcp_reachable,
                self.pg_host,
                self.pg_port,
                self.tcp_timeout_seconds,
            )
            if pg_up:
                use_asyncpg = _has_module("asyncpg")
                use_threaded_psycopg = (not use_asyncpg) and _is_windows_proactor_loop()
                try:
                    if use_threaded_psycopg:
                        sync_engine, sync_factory, pg_url = await asyncio.to_thread(
                            self._init_postgres_sync_threaded
                        )
                        self._sync_pg_engine = sync_engine
                        self._sync_pg_session_factory = sync_factory
                        self.db_mode = "postgres"
                        self.active_url = pg_url
                        self.fallback_reason = None
                        logger.info(
                            "Database dialect=postgresql connected (psycopg3 Windows threaded pool) to isolated tryon_db (%s:%d)",
                            self.pg_host,
                            self.pg_port,
                        )
                        return self.db_mode

                    await self._init_postgres_async(prefer_asyncpg=use_asyncpg)
                    return self.db_mode
                except Exception as exc:
                    self.fallback_reason = f"postgres_init_failed:{exc.__class__.__name__}"
                    logger.warning(
                        "PostgreSQL %s:%d reachable but init failed (%s: %s); falling back to SQLite.",
                        self.pg_host,
                        self.pg_port,
                        exc.__class__.__name__,
                        str(exc)[:220],
                    )
            else:
                self.fallback_reason = f"postgres_unreachable:{self.pg_host}:{self.pg_port}"
                logger.info(
                    "PostgreSQL %s:%d unreachable (INFRA_MODE=%s); falling back to isolated SQLite tryon_db.",
                    self.pg_host,
                    self.pg_port,
                    self.infra_mode or "AUTO",
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
            "Database dialect=sqlite initialized isolated tryon_db fallback at %s",
            self.sqlite_path,
        )
        return self.db_mode

    @staticmethod
    def _postgres_phase5_ddl_statements() -> tuple[str, ...]:
        return (
            "ALTER TABLE tryon_demand_events ADD COLUMN IF NOT EXISTS sku_code VARCHAR(64)",
            "ALTER TABLE tryon_demand_events ADD COLUMN IF NOT EXISTS size_code VARCHAR(16)",
            "ALTER TABLE tryon_sessions ADD COLUMN IF NOT EXISTS error_code VARCHAR(64)",
            "ALTER TABLE tryon_sessions ADD COLUMN IF NOT EXISTS provider_display_badge VARCHAR(96)",
            "ALTER TABLE tryon_sessions ADD COLUMN IF NOT EXISTS cache_key VARCHAR(128)",
            "ALTER TABLE tryon_sessions ADD COLUMN IF NOT EXISTS lighting_preset VARCHAR(32)",
            "ALTER TABLE tryon_sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ",
            "ALTER TABLE tryon_sessions ADD COLUMN IF NOT EXISTS is_purged BOOLEAN NOT NULL DEFAULT false",
            "ALTER TABLE tryon_sessions ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ",
            "CREATE INDEX IF NOT EXISTS idx_temp_user_images_unpurged_expires ON temp_user_images (expires_at) WHERE is_purged = false",
        )

    def _ensure_phase5_columns_sync(self, conn: Any) -> None:
        for ddl in self._postgres_phase5_ddl_statements():
            conn.execute(text(ddl))

    async def _ensure_phase5_columns(self, conn: object, *, is_postgres: bool) -> None:
        """Idempotently ensure Phase 5 columns & Phase 6 filtered unpurged index."""
        if is_postgres:
            for ddl in self._postgres_phase5_ddl_statements():
                await conn.execute(text(ddl))  # type: ignore[attr-defined]
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
        if "cache_key" not in sess_cols:
            await conn.execute(  # type: ignore[attr-defined]
                text("ALTER TABLE tryon_sessions ADD COLUMN cache_key VARCHAR(128)")
            )
        if "lighting_preset" not in sess_cols:
            await conn.execute(  # type: ignore[attr-defined]
                text("ALTER TABLE tryon_sessions ADD COLUMN lighting_preset VARCHAR(32)")
            )
        if "expires_at" not in sess_cols:
            await conn.execute(  # type: ignore[attr-defined]
                text("ALTER TABLE tryon_sessions ADD COLUMN expires_at DATETIME")
            )
        if "is_purged" not in sess_cols:
            await conn.execute(  # type: ignore[attr-defined]
                text("ALTER TABLE tryon_sessions ADD COLUMN is_purged BOOLEAN NOT NULL DEFAULT 0")
            )
        if "purged_at" not in sess_cols:
            await conn.execute(  # type: ignore[attr-defined]
                text("ALTER TABLE tryon_sessions ADD COLUMN purged_at DATETIME")
            )
        await conn.execute(  # type: ignore[attr-defined]
            text(
                "CREATE INDEX IF NOT EXISTS idx_temp_user_images_unpurged_expires "
                "ON temp_user_images (expires_at) WHERE is_purged = 0"
            )
        )

    def session(self) -> Any:
        if self._sync_pg_session_factory is not None:
            return _ThreadedAsyncSession(self._sync_pg_session_factory)
        if self.session_factory is None:
            raise RuntimeError("TryOnDatabase.initialize() must be called before opening a session.")
        return self.session_factory()

    async def ping(self) -> bool:
        if self._sync_pg_engine is not None:
            def _ping_sync() -> bool:
                with self._sync_pg_engine.connect() as conn:  # type: ignore[union-attr]
                    conn.execute(text("SELECT 1"))
                return True

            try:
                return await asyncio.to_thread(_ping_sync)
            except Exception:
                return False

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
        if self._sync_pg_engine is not None:
            eng = self._sync_pg_engine
            self._sync_pg_engine = None
            self._sync_pg_session_factory = None
            await asyncio.to_thread(eng.dispose)
