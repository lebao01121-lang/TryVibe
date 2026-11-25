from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

try:
    import redis.asyncio as aioredis
except ImportError:  # pragma: no cover - optional in bare environments
    aioredis = None  # type: ignore[assignment]

LOYALTY_QUOTA_LIMITS: dict[str, int] = {
    "BRONZE": 10,
    "SILVER": 12,
    "GOLD": 15,
    "DIAMOND": 25,
}

# Works identically on real Redis 7 AND scripts/local-infra-dev.mjs
LUA_DUAL_QUOTA_RESERVE = """
-- ATELIER_LUA_QUOTA
local userKey = KEYS[1]
local ipKey = KEYS[2]
local userLimit = tonumber(ARGV[1])
local ipLimit = tonumber(ARGV[2])
local ttlSec = tonumber(ARGV[3])

local userUsed = 0
if userKey ~= nil and userKey ~= '' then
  userUsed = tonumber(redis.call('GET', userKey) or '0')
end
local ipUsed = 0
if ipKey ~= nil and ipKey ~= '' then
  ipUsed = tonumber(redis.call('GET', ipKey) or '0')
end

if userKey ~= nil and userKey ~= '' and userLimit > 0 and userUsed >= userLimit then
  return {0, 'USER_QUOTA_EXCEEDED', 0, math.max(0, ipLimit - ipUsed)}
end
if ipKey ~= nil and ipKey ~= '' and ipLimit > 0 and ipUsed >= ipLimit then
  return {0, 'IP_QUOTA_EXCEEDED', math.max(0, userLimit - userUsed), 0}
end

local newUserUsed = userUsed
if userKey ~= nil and userKey ~= '' then
  newUserUsed = redis.call('INCR', userKey)
  if newUserUsed == 1 then
    redis.call('EXPIRE', userKey, ttlSec)
  end
end

local newIpUsed = ipUsed
if ipKey ~= nil and ipKey ~= '' then
  newIpUsed = redis.call('INCR', ipKey)
  if newIpUsed == 1 then
    redis.call('EXPIRE', ipKey, ttlSec)
  end
end

return {
  1,
  userKey ~= '' and math.max(0, userLimit - newUserUsed) or 0,
  ipKey ~= '' and math.max(0, ipLimit - newIpUsed) or 0
}
"""

LUA_DUAL_QUOTA_REFUND = """
-- ATELIER_LUA_QUOTA_REFUND
local dec = tonumber(ARGV[1] or '1')
for i, key in ipairs(KEYS) do
  if key ~= nil and key ~= '' then
    local cur = tonumber(redis.call('GET', key) or '0')
    local nextVal = math.max(0, cur - dec)
    redis.call('SET', key, tostring(nextVal), 'KEEPTTL')
  end
end
return {1}
"""


SLOT_PHYSICAL_ORDER: dict[str, int] = {
    "upper": 1,
    "top": 1,
    "onepiece": 1,
    "one_piece": 1,
    "overall": 1,
    "lower": 2,
    "bottom": 2,
    "outerwear": 3,
    "accessory": 4,
}


def normalize_garment_slot(slot: str | None) -> str:
    """Normalize incoming slot names to canonical ('upper'|'lower'|'onePiece'|'outerwear'|'accessory')."""
    raw = (slot or "upper").strip().lower().replace("-", "_")
    if raw in ("upper", "top", "shirt", "blouse", "sweater"):
        return "upper"
    if raw in ("lower", "bottom", "pants", "trousers", "skirt"):
        return "lower"
    if raw in ("onepiece", "one_piece", "overall", "dress", "jumpsuit"):
        return "onePiece"
    if raw in ("outerwear", "jacket", "coat", "blazer", "cardigan"):
        return "outerwear"
    if raw == "accessory":
        return "accessory"
    return "upper"


def sort_garments_physically(garments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Order garments physically: UPPER/ONE_PIECE -> LOWER -> OUTERWEAR -> ACCESSORY."""
    def _sort_key(item: dict[str, Any]) -> tuple[int, str, str, str, str]:
        slot_norm = normalize_garment_slot(str(item.get("slot") or "upper"))
        prio = SLOT_PHYSICAL_ORDER.get(slot_norm.lower(), 5)
        return (
            prio,
            slot_norm.lower(),
            str(item.get("productId") or item.get("product_id") or "").strip(),
            str(item.get("variantId") or item.get("variant_id") or "").strip(),
            str(item.get("colorHex") or item.get("color_hex") or "").strip().lower(),
        )

    return sorted(garments, key=_sort_key)


def format_garment_variant_pair(garment: dict[str, Any]) -> str:
    """Build deterministic variant pair identifier for Stage 2 SHA-256 cache keys."""
    slot_norm = normalize_garment_slot(str(garment.get("slot") or "upper"))
    product_id = str(garment.get("productId") or garment.get("product_id") or "").strip()
    variant_id = str(garment.get("variantId") or garment.get("variant_id") or "").strip()
    color_hex = str(garment.get("colorHex") or garment.get("color_hex") or "").strip().lower()
    image_url = str(
        garment.get("garmentImageUrl")
        or garment.get("garment_image_url")
        or garment.get("cleanGarmentUrl768x1024")
        or ""
    ).strip()
    parts = [slot_norm, product_id, variant_id]
    if color_hex:
        parts.append(color_hex)
    if image_url and not variant_id:
        parts.append(hashlib.sha256(image_url.encode("utf-8")).hexdigest()[:12])
    return ":".join(parts)


def compute_v2_cache_key(
    *,
    person_frame_sha256: str,
    garments: list[dict[str, Any]],
    lighting_preset: str = "atelier",
) -> str:
    """
    Compute exact Stage 2 Redis cache key:
      tryon:v2:<sha256(personFrameSha256 + "|" + orderedVariantPairs + "|" + lightingPreset)>
    """
    ordered = sort_garments_physically(garments)
    ordered_variant_pairs = ",".join(format_garment_variant_pair(g) for g in ordered)
    canonical = (
        f"{person_frame_sha256.strip().lower()}|"
        f"{ordered_variant_pairs}|"
        f"{(lighting_preset or 'atelier').strip().lower()}"
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"tryon:v2:{digest}"


def compute_v2_step1_cache_key(
    *,
    person_frame_sha256: str,
    step1_garment: dict[str, Any],
    lighting_preset: str = "atelier",
) -> str:
    """Intermediate Step 1 cache key for OUTFIT mode so switching Bottom skips Step 1."""
    step1_pair = format_garment_variant_pair(step1_garment)
    canonical = (
        f"{person_frame_sha256.strip().lower()}|"
        f"{step1_pair}|"
        f"{(lighting_preset or 'atelier').strip().lower()}"
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"tryon:v2:step1:{digest}"


def compute_session_cache_hash(
    *,
    sha256_hash: str,
    mode: str,
    upper_product_id: str | None = None,
    upper_variant_id: str | None = None,
    lower_product_id: str | None = None,
    lower_variant_id: str | None = None,
    one_piece_product_id: str | None = None,
    one_piece_variant_id: str | None = None,
) -> str:
    """Compute exact Phase 4 deterministic SHA-256 cache hash for a try-on session."""
    canonical = (
        f"{sha256_hash}:{mode}:{upper_product_id or ''}:{upper_variant_id or ''}:"
        f"{lower_product_id or ''}:{lower_variant_id or ''}:"
        f"{one_piece_product_id or ''}:{one_piece_variant_id or ''}"
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class QuotaDecision:
    allowed: bool
    user_id: str
    used_today: int
    daily_limit: int
    remaining: int
    backend: str


@dataclass(frozen=True)
class DualQuotaSnapshot:
    allowed: bool
    reason: str | None
    daily_limit: int
    used_today: int
    remaining_quota: int
    ip_limit: int
    ip_used: int
    ip_remaining: int
    backend: str


class TryOnCacheQuota:
    """SHA-256 VTON result cache + dual (user + IP) daily/weekly quota guard with Redis & memory fallback."""

    CACHE_PREFIX = "tryon:cache"
    CACHE_V2_PREFIX = "tryon:v2"
    CACHE_V2_STEP1_PREFIX = "tryon:v2:step1"
    LEGACY_CACHE_PREFIX = "atelier:tryon:cache"
    QUOTA_PREFIX = "tryon:quota"
    JOB_STATE_PREFIX = "tryon:job"
    CANCELLED_PREFIX = "tryon:cancelled"
    REFUND_GUARD_PREFIX = "tryon:refunded"

    def __init__(
        self,
        *,
        redis_url: str,
        daily_limit: int = 10,
        guest_ip_limit: int = 5,
        auth_ip_limit: int = 30,
        cache_ttl_seconds: int = 900,
        is_production: bool = False,
        dev_loopback_ip_limit: int = 60,
    ) -> None:
        self.redis_url = redis_url
        self.daily_limit = daily_limit
        self.guest_ip_limit = guest_ip_limit
        self.auth_ip_limit = auth_ip_limit
        self.cache_ttl_seconds = cache_ttl_seconds
        self.is_production = is_production
        self.dev_loopback_ip_limit = dev_loopback_ip_limit
        self._redis_client: Any | None = None
        self._memory_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._memory_quota: dict[str, int] = {}
        self._memory_jobs: dict[str, tuple[float, dict[str, Any]]] = {}
        self._memory_cancelled: dict[str, float] = {}
        self._memory_refunded: dict[str, float] = {}

    @classmethod
    def resolve_user_limit(
        cls,
        loyalty_tier: str | None,
        default_limit: int = 10,
    ) -> int:
        if not loyalty_tier:
            return default_limit
        return LOYALTY_QUOTA_LIMITS.get(loyalty_tier.strip().upper(), default_limit)

    @classmethod
    def build_cache_redis_key(cls, cache_hash: str) -> str:
        if (
            cache_hash.startswith(f"{cls.CACHE_V2_PREFIX}:")
            or cache_hash.startswith(f"{cls.CACHE_PREFIX}:")
            or cache_hash.startswith(f"{cls.LEGACY_CACHE_PREFIX}:")
        ):
            return cache_hash
        return f"{cls.CACHE_PREFIX}:{cache_hash}"

    @classmethod
    def compute_cache_key(
        cls,
        *,
        person_fingerprint: str,
        garment_sku_id: str,
        garment_category: str = "TOP",
        provider: str = "mock",
        aspect_ratio: str = "2:3",
    ) -> str:
        """Backward-compatible Phase 0 cache key helper."""
        canonical = "|".join(
            [
                provider.strip().lower(),
                garment_sku_id.strip(),
                garment_category.strip().upper(),
                aspect_ratio.strip(),
                person_fingerprint.strip(),
            ]
        )
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        return f"{cls.LEGACY_CACHE_PREFIX}:{digest}"

    @classmethod
    def build_user_quota_key(cls, user_id: str, now: datetime | None = None) -> str:
        day_stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%d")
        return f"{cls.QUOTA_PREFIX}:user:{user_id.strip()}:{day_stamp}"

    @classmethod
    def build_ip_quota_key(cls, ip_address: str, now: datetime | None = None) -> str:
        day_stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%d")
        clean_ip = (ip_address or "127.0.0.1").strip()
        return f"{cls.QUOTA_PREFIX}:ip:{clean_ip}:{day_stamp}"

    @classmethod
    def build_quota_key(cls, user_id: str, now: datetime | None = None) -> str:
        return cls.build_user_quota_key(user_id, now)

    async def _get_redis(self) -> Any | None:
        if aioredis is None:
            return None
        if self._redis_client is None:
            self._redis_client = aioredis.from_url(
                self.redis_url,
                encoding="utf-8",
                decode_responses=True,
                protocol=2,
                socket_connect_timeout=0.75,
                socket_timeout=1.0,
            )
        return self._redis_client

    async def ping(self) -> bool:
        client = await self._get_redis()
        if client is None:
            return False
        try:
            return bool(await client.ping())
        except Exception:
            return False

    async def close(self) -> None:
        if self._redis_client is not None:
            try:
                await self._redis_client.aclose()
            except Exception:
                pass
            self._redis_client = None

    async def get_cached(self, cache_key_or_hash: str) -> dict[str, Any] | None:
        key = self.build_cache_redis_key(cache_key_or_hash)
        client = await self._get_redis()
        if client is not None:
            try:
                raw = await client.get(key)
                if raw:
                    return json.loads(raw)
                return None
            except Exception:
                pass

        entry = self._memory_cache.get(key)
        if not entry:
            return None
        expires_at, payload = entry
        if time.monotonic() >= expires_at:
            self._memory_cache.pop(key, None)
            return None
        return payload

    async def set_cached(
        self,
        cache_key_or_hash: str,
        payload: dict[str, Any],
        *,
        ttl_seconds: int | None = None,
    ) -> str:
        key = self.build_cache_redis_key(cache_key_or_hash)
        ttl = ttl_seconds or self.cache_ttl_seconds
        client = await self._get_redis()
        if client is not None:
            try:
                await client.set(key, json.dumps(payload), ex=ttl)
                return "redis"
            except Exception:
                pass

        self._memory_cache[key] = (time.monotonic() + ttl, payload)
        return "memory-fallback"

    async def delete_cached(self, cache_key_or_hash: str) -> bool:
        key = self.build_cache_redis_key(cache_key_or_hash)
        self._memory_cache.pop(key, None)
        client = await self._get_redis()
        if client is not None:
            try:
                await client.delete(key)
                return True
            except Exception:
                return False
        return True

    def _limits_and_keys(
        self,
        *,
        user_id: str | None,
        ip_address: str,
        loyalty_tier: str | None = None,
    ) -> tuple[str, str, int, int]:
        clean_user = user_id.strip() if user_id and user_id.strip() else ""
        clean_ip = (ip_address or "127.0.0.1").strip()
        user_key = self.build_user_quota_key(clean_user) if clean_user else ""
        ip_key = self.build_ip_quota_key(clean_ip)
        user_limit = (
            self.resolve_user_limit(loyalty_tier, self.daily_limit) if clean_user else 0
        )
        base_guest_ip_limit = self.guest_ip_limit
        if not self.is_production and clean_ip in ("127.0.0.1", "::1", "localhost"):
            base_guest_ip_limit = max(self.guest_ip_limit, self.dev_loopback_ip_limit)
        ip_limit = self.auth_ip_limit if clean_user else base_guest_ip_limit
        return user_key, ip_key, user_limit, ip_limit

    @classmethod
    def build_weekly_quota_key(cls, owner_key: str, now: datetime | None = None) -> str:
        iso_year, iso_week, _ = (now or datetime.now(timezone.utc)).isocalendar()
        return f"{cls.QUOTA_PREFIX}:week:{owner_key.strip()}:{iso_year}W{iso_week:02d}"

    async def set_job_state(
        self,
        job_id: str,
        payload: dict[str, Any],
        *,
        ttl_seconds: int = 900,
    ) -> None:
        key = f"{self.JOB_STATE_PREFIX}:{job_id}"
        self._memory_jobs[key] = (time.monotonic() + ttl_seconds, dict(payload))
        client = await self._get_redis()
        if client is not None:
            try:
                await client.set(key, json.dumps(payload), ex=ttl_seconds)
            except Exception:
                pass

    async def get_job_state(self, job_id: str) -> dict[str, Any] | None:
        key = f"{self.JOB_STATE_PREFIX}:{job_id}"
        client = await self._get_redis()
        if client is not None:
            try:
                raw = await client.get(key)
                if raw:
                    return json.loads(raw)
            except Exception:
                pass

        entry = self._memory_jobs.get(key)
        if not entry:
            return None
        expires_at, payload = entry
        if time.monotonic() >= expires_at:
            self._memory_jobs.pop(key, None)
            return None
        return dict(payload)

    async def delete_job_state(self, job_id: str) -> None:
        key = f"{self.JOB_STATE_PREFIX}:{job_id}"
        self._memory_jobs.pop(key, None)
        client = await self._get_redis()
        if client is not None:
            try:
                await client.delete(key)
            except Exception:
                pass

    async def mark_job_cancelled(self, job_id: str, *, ttl_seconds: int = 1800) -> None:
        key = f"{self.CANCELLED_PREFIX}:{job_id}"
        self._memory_cancelled[key] = time.monotonic() + ttl_seconds
        client = await self._get_redis()
        if client is not None:
            try:
                await client.set(key, "1", ex=ttl_seconds)
            except Exception:
                pass

    async def is_job_cancelled(self, job_id: str) -> bool:
        key = f"{self.CANCELLED_PREFIX}:{job_id}"
        exp = self._memory_cancelled.get(key)
        if exp is not None:
            if time.monotonic() < exp:
                return True
            self._memory_cancelled.pop(key, None)
        client = await self._get_redis()
        if client is not None:
            try:
                val = await client.get(key)
                return bool(val)
            except Exception:
                pass
        return False

    async def _claim_refund_once(self, job_id: str) -> bool:
        """Return True only the first time a refund is claimed for `job_id` (prevents double-refund)."""
        key = f"{self.REFUND_GUARD_PREFIX}:{job_id}"
        now = time.monotonic()
        existing = self._memory_refunded.get(key)
        if existing is not None and now < existing:
            return False
        self._memory_refunded[key] = now + 3600.0
        client = await self._get_redis()
        if client is not None:
            try:
                acquired = await client.set(key, "1", ex=3600, nx=True)
                return bool(acquired)
            except Exception:
                pass
        return True

    def _build_snapshot(
        self,
        *,
        allowed: bool,
        reason: str | None,
        has_user: bool,
        user_limit: int,
        user_used: int,
        ip_limit: int,
        ip_used: int,
        backend: str,
    ) -> DualQuotaSnapshot:
        user_rem = max(0, user_limit - user_used) if has_user else 0
        ip_rem = max(0, ip_limit - ip_used)
        if has_user:
            effective_limit = user_limit
            effective_used = user_used
            effective_rem = min(user_rem, ip_rem)
        else:
            effective_limit = ip_limit
            effective_used = ip_used
            effective_rem = ip_rem
        return DualQuotaSnapshot(
            allowed=allowed,
            reason=reason,
            daily_limit=effective_limit,
            used_today=effective_used,
            remaining_quota=effective_rem,
            ip_limit=ip_limit,
            ip_used=ip_used,
            ip_remaining=ip_rem,
            backend=backend,
        )

    async def get_dual_quota(
        self,
        *,
        user_id: str | None,
        ip_address: str,
        loyalty_tier: str | None = None,
    ) -> DualQuotaSnapshot:
        """Read-only dual daily quota inspection (does NOT deduct)."""
        user_key, ip_key, user_limit, ip_limit = self._limits_and_keys(
            user_id=user_id,
            ip_address=ip_address,
            loyalty_tier=loyalty_tier,
        )
        has_user = bool(user_key)
        client = await self._get_redis()
        if client is not None:
            try:
                user_raw = await client.get(user_key) if has_user else None
                ip_raw = await client.get(ip_key) if ip_key else None
                user_used = int(user_raw) if user_raw else 0
                ip_used = int(ip_raw) if ip_raw else 0
                reason = None
                if has_user and user_used >= user_limit:
                    reason = "USER_QUOTA_EXCEEDED"
                elif ip_used >= ip_limit:
                    reason = "IP_QUOTA_EXCEEDED"
                return self._build_snapshot(
                    allowed=reason is None,
                    reason=reason,
                    has_user=has_user,
                    user_limit=user_limit,
                    user_used=user_used,
                    ip_limit=ip_limit,
                    ip_used=ip_used,
                    backend="redis",
                )
            except Exception:
                pass

        user_used = self._memory_quota.get(user_key, 0) if has_user else 0
        ip_used = self._memory_quota.get(ip_key, 0)
        reason = None
        if has_user and user_used >= user_limit:
            reason = "USER_QUOTA_EXCEEDED"
        elif ip_used >= ip_limit:
            reason = "IP_QUOTA_EXCEEDED"
        return self._build_snapshot(
            allowed=reason is None,
            reason=reason,
            has_user=has_user,
            user_limit=user_limit,
            user_used=user_used,
            ip_limit=ip_limit,
            ip_used=ip_used,
            backend="memory-fallback",
        )

    async def deduct_dual_quota(
        self,
        *,
        user_id: str | None,
        ip_address: str,
        loyalty_tier: str | None = None,
    ) -> DualQuotaSnapshot:
        """Atomically check & deduct 1 unit from user + IP daily quotas via Redis Lua."""
        user_key, ip_key, user_limit, ip_limit = self._limits_and_keys(
            user_id=user_id,
            ip_address=ip_address,
            loyalty_tier=loyalty_tier,
        )
        has_user = bool(user_key)
        client = await self._get_redis()
        if client is not None:
            try:
                res = await client.eval(
                    LUA_DUAL_QUOTA_RESERVE,
                    2,
                    user_key,
                    ip_key,
                    str(user_limit),
                    str(ip_limit),
                    "86400",
                )
                if isinstance(res, (list, tuple)) and len(res) >= 3:
                    ok_flag = int(res[0])
                    if ok_flag == 1:
                        user_rem = int(res[1]) if has_user else 0
                        ip_rem = int(res[2])
                        user_used = max(0, user_limit - user_rem) if has_user else 0
                        ip_used = max(0, ip_limit - ip_rem)
                        return self._build_snapshot(
                            allowed=True,
                            reason=None,
                            has_user=has_user,
                            user_limit=user_limit,
                            user_used=user_used,
                            ip_limit=ip_limit,
                            ip_used=ip_used,
                            backend="redis",
                        )
                    reason = str(res[1])
                    user_rem = int(res[2]) if len(res) > 2 else 0
                    ip_rem = int(res[3]) if len(res) > 3 else 0
                    user_used = max(0, user_limit - user_rem) if has_user else 0
                    ip_used = max(0, ip_limit - ip_rem)
                    return self._build_snapshot(
                        allowed=False,
                        reason=reason,
                        has_user=has_user,
                        user_limit=user_limit,
                        user_used=user_used,
                        ip_limit=ip_limit,
                        ip_used=ip_used,
                        backend="redis",
                    )
            except Exception:
                pass

        user_used = self._memory_quota.get(user_key, 0) if has_user else 0
        ip_used = self._memory_quota.get(ip_key, 0)
        if has_user and user_used >= user_limit:
            return self._build_snapshot(
                allowed=False,
                reason="USER_QUOTA_EXCEEDED",
                has_user=has_user,
                user_limit=user_limit,
                user_used=user_used,
                ip_limit=ip_limit,
                ip_used=ip_used,
                backend="memory-fallback",
            )
        if ip_used >= ip_limit:
            return self._build_snapshot(
                allowed=False,
                reason="IP_QUOTA_EXCEEDED",
                has_user=has_user,
                user_limit=user_limit,
                user_used=user_used,
                ip_limit=ip_limit,
                ip_used=ip_used,
                backend="memory-fallback",
            )
        if has_user:
            user_used += 1
            self._memory_quota[user_key] = user_used
        ip_used += 1
        self._memory_quota[ip_key] = ip_used
        return self._build_snapshot(
            allowed=True,
            reason=None,
            has_user=has_user,
            user_limit=user_limit,
            user_used=user_used,
            ip_limit=ip_limit,
            ip_used=ip_used,
            backend="memory-fallback",
        )

    async def refund_dual_quota(
        self,
        *,
        user_id: str | None,
        ip_address: str,
        loyalty_tier: str | None = None,
    ) -> DualQuotaSnapshot:
        """Refund +1 quota unit on VTON provider failure (clamped >= 0)."""
        user_key, ip_key, _, _ = self._limits_and_keys(
            user_id=user_id,
            ip_address=ip_address,
            loyalty_tier=loyalty_tier,
        )
        client = await self._get_redis()
        if client is not None:
            try:
                await client.eval(LUA_DUAL_QUOTA_REFUND, 2, user_key, ip_key, "1")
                return await self.get_dual_quota(
                    user_id=user_id,
                    ip_address=ip_address,
                    loyalty_tier=loyalty_tier,
                )
            except Exception:
                pass

        if user_key:
            self._memory_quota[user_key] = max(0, self._memory_quota.get(user_key, 0) - 1)
        if ip_key:
            self._memory_quota[ip_key] = max(0, self._memory_quota.get(ip_key, 0) - 1)
        return await self.get_dual_quota(
            user_id=user_id,
            ip_address=ip_address,
            loyalty_tier=loyalty_tier,
        )

    async def refund_quota(
        self,
        user_id: str | None,
        client_ip: str,
        *,
        loyalty_tier: str | None = None,
        job_id: str | None = None,
    ) -> DualQuotaSnapshot:
        """
        Stage 2 idempotent +1 quota rollback on POSE_TOO_CLOSE, NO_PERSON_DETECTED,
        processing failure, or pre-completion cancel.
        """
        if job_id:
            first_claim = await self._claim_refund_once(job_id)
            if not first_claim:
                return await self.get_dual_quota(
                    user_id=user_id,
                    ip_address=client_ip,
                    loyalty_tier=loyalty_tier,
                )
        return await self.refund_dual_quota(
            user_id=user_id,
            ip_address=client_ip,
            loyalty_tier=loyalty_tier,
        )

    async def consume_quota(
        self,
        user_id: str,
        *,
        daily_limit: int | None = None,
    ) -> QuotaDecision:
        """Backward-compatible Phase 0 quota helper used by `/api/v1/tryon/preview-mock`."""
        limit = daily_limit or self.daily_limit
        snap = await self.deduct_dual_quota(
            user_id=user_id,
            ip_address="127.0.0.1",
            loyalty_tier=None,
        )
        return QuotaDecision(
            allowed=snap.allowed,
            user_id=user_id,
            used_today=snap.used_today,
            daily_limit=limit,
            remaining=max(0, limit - snap.used_today) if snap.allowed else 0,
            backend=snap.backend,
        )
