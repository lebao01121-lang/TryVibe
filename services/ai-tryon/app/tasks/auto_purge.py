from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import or_, select

from app.cache_quota.quota import TryOnCacheQuota
from app.db.database import TryOnDatabase
from app.db.models import TempUserImage, TryOnJob, TryOnResult, TryOnSession, utcnow
from app.storage.minio_client import MinioStorageClient

logger = logging.getLogger("atelier.ai_tryon.auto_purge")


def _parse_iso_utc(raw: str | None) -> datetime | None:
    if not raw or not raw.strip():
        return None
    cleaned = raw.strip()
    if cleaned.endswith("Z"):
        cleaned = cleaned[:-1] + "+00:00"
    parsed = datetime.fromisoformat(cleaned)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


@dataclass
class PurgeReport:
    cutoff_utc: datetime
    ttl_minutes: int
    bucket: str
    purged_images: int = 0
    purged_results: int = 0
    purged_sessions: int = 0
    deleted_keys: list[str] = field(default_factory=list)
    deleted_cache_keys: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    @property
    def purged_objects(self) -> int:
        return len(self.deleted_keys)

    @property
    def purged_db_rows(self) -> int:
        return self.purged_images + self.purged_results + self.purged_sessions

    def as_dict(self) -> dict[str, Any]:
        effective_sessions = max(
            self.purged_sessions,
            self.purged_results,
            self.purged_images,
        )
        return {
            "cutoffUtc": self.cutoff_utc.isoformat(),
            "ttlMinutes": self.ttl_minutes,
            "bucket": self.bucket,
            "purgedSessions": effective_sessions,
            "deletedObjects": self.purged_objects,
            "purgedImages": self.purged_images,
            "purgedResults": self.purged_results,
            "purgedObjects": self.purged_objects,
            "purgedDbRows": self.purged_db_rows,
            "deletedKeys": self.deleted_keys,
            "deletedCacheKeys": self.deleted_cache_keys,
            "errors": self.errors,
        }


class TryOnAutoPurgeTask:
    """15-minute privacy auto-purge targeting MinIO `atelier-private-tryon`, Redis cache & `tryon_db`."""

    def __init__(
        self,
        *,
        db: TryOnDatabase | None = None,
        minio: MinioStorageClient | None = None,
        cache_quota: TryOnCacheQuota | None = None,
        private_bucket: str = "atelier-private-tryon",
        ttl_minutes: int = 15,
        interval_seconds: int = 60,
    ) -> None:
        self.db = db
        self.minio = minio
        self.cache_quota = cache_quota
        self.private_bucket = private_bucket
        self.ttl_minutes = ttl_minutes
        self.interval_seconds = interval_seconds

        self._stop_event = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self.last_report: PurgeReport | None = None

    async def run_once(
        self,
        *,
        force_before_iso: str | None = None,
        session_id: str | None = None,
    ) -> PurgeReport:
        actual_now = utcnow()
        effective_now = _parse_iso_utc(force_before_iso) or actual_now
        cutoff_utc = effective_now - timedelta(minutes=self.ttl_minutes)
        report = PurgeReport(
            cutoff_utc=effective_now,
            ttl_minutes=self.ttl_minutes,
            bucket=self.private_bucket,
        )

        keys_to_delete: list[str] = []
        expired_session_ids: set[str] = set()
        expired_result_keys: set[str] = set()
        cache_keys_to_clear: set[str] = set()

        # 1. Query expired temp_user_images, tryon_results, and tryon_sessions in isolated tryon_db
        if self.db is not None and self.db.session_factory is not None:
            try:
                async with self.db.session() as db_sess:
                    if session_id:
                        target_sess = await db_sess.get(TryOnSession, session_id)
                        if target_sess is not None:
                            expired_session_ids.add(target_sess.id)
                            if not target_sess.is_purged:
                                target_sess.is_purged = True
                                target_sess.purged_at = actual_now
                                report.purged_sessions += 1
                            if target_sess.cache_key:
                                cache_keys_to_clear.add(target_sess.cache_key)
                            if target_sess.temp_image_id:
                                img = await db_sess.get(TempUserImage, target_sess.temp_image_id)
                                if img is not None:
                                    if img.minio_object_key:
                                        keys_to_delete.append(img.minio_object_key)
                                    if not img.is_purged:
                                        img.is_purged = True
                                        img.purged_at = actual_now
                                        report.purged_images += 1
                        res_rows = (
                            await db_sess.execute(
                                select(TryOnResult).where(TryOnResult.session_id == session_id)
                            )
                        ).scalars().all()
                        for res in res_rows:
                            if res.result_object_key:
                                keys_to_delete.append(res.result_object_key)
                                expired_result_keys.add(res.result_object_key)
                            if not res.is_purged:
                                res.is_purged = True
                                report.purged_results += 1
                    else:
                        img_rows = (
                            await db_sess.execute(
                                select(TempUserImage).where(
                                    TempUserImage.is_purged.is_(False),
                                    or_(
                                        TempUserImage.expires_at <= effective_now,
                                        TempUserImage.created_at <= cutoff_utc,
                                    ),
                                )
                            )
                        ).scalars().all()

                        expired_temp_img_ids: set[str] = set()
                        for img in img_rows:
                            if img.minio_object_key:
                                keys_to_delete.append(img.minio_object_key)
                            img.is_purged = True
                            img.purged_at = actual_now
                            expired_temp_img_ids.add(img.id)
                            report.purged_images += 1

                        res_rows = (
                            await db_sess.execute(
                                select(TryOnResult).where(
                                    TryOnResult.is_purged.is_(False),
                                    or_(
                                        TryOnResult.expires_at <= effective_now,
                                        TryOnResult.created_at <= cutoff_utc,
                                    ),
                                )
                            )
                        ).scalars().all()

                        for res in res_rows:
                            if res.result_object_key:
                                keys_to_delete.append(res.result_object_key)
                                expired_result_keys.add(res.result_object_key)
                            res.is_purged = True
                            expired_session_ids.add(res.session_id)
                            report.purged_results += 1

                        # Also sweep unpurged TryOnSession rows whose expires_at <= effective_now or created_at <= cutoff_utc
                        sess_conds = [
                            TryOnSession.expires_at <= effective_now,
                            TryOnSession.created_at <= cutoff_utc,
                        ]
                        if expired_session_ids:
                            sess_conds.append(TryOnSession.id.in_(list(expired_session_ids)))
                        if expired_temp_img_ids:
                            sess_conds.append(
                                TryOnSession.temp_image_id.in_(list(expired_temp_img_ids))
                            )

                        sess_rows = (
                            await db_sess.execute(
                                select(TryOnSession).where(
                                    TryOnSession.is_purged.is_(False),
                                    or_(*sess_conds),
                                )
                            )
                        ).scalars().all()
                        for srow in sess_rows:
                            srow.is_purged = True
                            srow.purged_at = actual_now
                            expired_session_ids.add(srow.id)
                            report.purged_sessions += 1
                            if srow.cache_key:
                                cache_keys_to_clear.add(srow.cache_key)
                            if srow.temp_image_id and srow.temp_image_id not in expired_temp_img_ids:
                                timg = await db_sess.get(TempUserImage, srow.temp_image_id)
                                if timg is not None:
                                    if timg.minio_object_key:
                                        keys_to_delete.append(timg.minio_object_key)
                                    if not timg.is_purged:
                                        timg.is_purged = True
                                        timg.purged_at = actual_now
                                        report.purged_images += 1

                    # Cascade purge flag to any CACHE_HIT TryOnResult rows referencing deleted result keys
                    if expired_result_keys:
                        shared_rows = (
                            await db_sess.execute(
                                select(TryOnResult).where(
                                    TryOnResult.is_purged.is_(False),
                                    TryOnResult.result_object_key.in_(list(expired_result_keys)),
                                )
                            )
                        ).scalars().all()
                        for srow in shared_rows:
                            srow.is_purged = True
                            expired_session_ids.add(srow.session_id)
                            report.purged_results += 1

                    # Collect cache hashes for all expired sessions so Redis cache is cleared too
                    if expired_session_ids:
                        jobs_rows = (
                            await db_sess.execute(
                                select(TryOnJob.cache_hash).where(
                                    TryOnJob.session_id.in_(list(expired_session_ids))
                                )
                            )
                        ).scalars().all()
                        for ch in jobs_rows:
                            if ch:
                                ch_str = str(ch)
                                cache_keys_to_clear.add(ch_str)
                                if not ch_str.startswith("tryon:"):
                                    cache_keys_to_clear.add(f"tryon:v2:{ch_str}")

                    await db_sess.commit()

                # Delete Redis cache keys & live job states
                if self.cache_quota is not None:
                    for ch in sorted(cache_keys_to_clear):
                        await self.cache_quota.delete_cached(ch)
                        report.deleted_cache_keys.append(
                            self.cache_quota.build_cache_redis_key(ch)
                        )
                    for sid in sorted(expired_session_ids):
                        await self.cache_quota.delete_job_state(sid)
            except Exception as exc:
                report.errors.append(f"tryon_db: {exc.__class__.__name__}: {exc}")

        # 2. Delete expired MinIO objects (uploads, results, and intermediate step files)
        if self.minio is not None:
            for sid in expired_session_ids:
                for ext in ("webp", "jpg", "png"):
                    keys_to_delete.append(f"intermediate/{sid}_step1.{ext}")

            unique_keys = list(dict.fromkeys(keys_to_delete))
            for obj_key in unique_keys:
                exists = await self.minio.head_object(key=obj_key)
                if not exists:
                    continue
                deleted = await self.minio.delete_object(key=obj_key)
                if deleted:
                    report.deleted_keys.append(obj_key)

            # Sweep orphaned files older than cutoff ONLY when not scoped to a single session_id
            if not session_id:
                try:
                    all_objects = await self.minio.list_objects()
                    for obj in all_objects:
                        obj_key = str(obj.get("key") or "")
                        last_mod = obj.get("last_modified")
                        if (
                            obj_key
                            and obj_key not in report.deleted_keys
                            and isinstance(last_mod, datetime)
                            and last_mod < cutoff_utc
                        ):
                            if await self.minio.delete_object(key=obj_key):
                                report.deleted_keys.append(obj_key)
                except Exception as exc:
                    report.errors.append(f"minio: {exc.__class__.__name__}")

        self.last_report = report
        return report

    async def expire_session_for_test(
        self,
        *,
        session_id: str | None = None,
        temp_image_id: str | None = None,
    ) -> dict[str, Any]:
        """Dev/test helper: backdate expires_at by 20 minutes so run_once() purges immediately."""
        if self.db is None or self.db.session_factory is None:
            raise RuntimeError("TryOnDatabase is not initialized.")

        past = utcnow() - timedelta(minutes=max(self.ttl_minutes + 5, 20))
        expired_images = 0
        expired_results = 0
        target_image_ids: set[str] = set()
        target_result_keys: set[str] = set()

        async with self.db.session() as db_sess:
            if session_id:
                sess = await db_sess.get(TryOnSession, session_id)
                if sess is not None:
                    target_image_ids.add(sess.temp_image_id)
                res_row = (
                    await db_sess.execute(
                        select(TryOnResult).where(TryOnResult.session_id == session_id)
                    )
                ).scalar_one_or_none()
                if res_row is not None:
                    res_row.expires_at = past
                    expired_results += 1
                    if res_row.result_object_key:
                        target_result_keys.add(res_row.result_object_key)
                if target_result_keys:
                    related_results = (
                        await db_sess.execute(
                            select(TryOnResult).where(
                                TryOnResult.result_object_key.in_(list(target_result_keys))
                            )
                        )
                    ).scalars().all()
                    for rel in related_results:
                        if rel.session_id != session_id:
                            rel.expires_at = past
                            expired_results += 1

            if temp_image_id:
                target_image_ids.add(temp_image_id)

            if target_image_ids:
                imgs = (
                    await db_sess.execute(
                        select(TempUserImage).where(
                            TempUserImage.id.in_(list(target_image_ids))
                        )
                    )
                ).scalars().all()
                for img in imgs:
                    img.expires_at = past
                    expired_images += 1
            elif not session_id and not temp_image_id:
                imgs = (
                    await db_sess.execute(
                        select(TempUserImage).where(TempUserImage.is_purged.is_(False))
                    )
                ).scalars().all()
                for img in imgs:
                    img.expires_at = past
                    expired_images += 1
                results = (
                    await db_sess.execute(
                        select(TryOnResult).where(TryOnResult.is_purged.is_(False))
                    )
                ).scalars().all()
                for r in results:
                    r.expires_at = past
                    expired_results += 1

            await db_sess.commit()

        return {
            "sessionId": session_id,
            "tempImageId": temp_image_id,
            "expiredImages": expired_images,
            "expiredResults": expired_results,
            "backdatedTo": past.isoformat(),
        }

    async def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=float(self.interval_seconds),
                )
            except asyncio.TimeoutError:
                report = await self.run_once()
                if report.purged_images or report.purged_results or report.deleted_keys:
                    logger.info(
                        "Auto-purge removed %d images, %d results, %d MinIO objects",
                        report.purged_images,
                        report.purged_results,
                        len(report.deleted_keys),
                    )

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._stop_event.clear()
            self._task = asyncio.create_task(self._loop(), name="tryon-auto-purge")

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def status_summary(self) -> dict[str, Any]:
        return {
            "enabled": self._task is not None and not self._task.done(),
            "targetBucket": self.private_bucket,
            "targetDatabase": "tryon_db",
            "ttlMinutes": self.ttl_minutes,
            "intervalSeconds": self.interval_seconds,
            "lastRun": self.last_report.as_dict() if self.last_report else None,
        }
