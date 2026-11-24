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
    """SHA-256 VTON result cache + dual (user + IP) daily quota guard with Redis & memory fallback."""

    CACHE_PREFIX = "tryon:cache"
    LEGACY_CACHE_PREFIX = "atelier:tryon:cache"
    QUOTA_PREFIX = "tryon:quota"

    def __init__(
        self,
        *,
        redis_url: str,
        daily_limit: int = 10,
        guest_ip_limit: int = 5,
        auth_ip_limit: int = 30,
        cache_ttl_seconds: int = 900,
    ) -> None:
        self.redis_url = redis_url
        self.daily_limit = daily_limit
        self.guest_ip_limit = guest_ip_limit
        self.auth_ip_limit = auth_ip_limit
        self.cache_ttl_seconds = cache_ttl_seconds
        self._redis_client: Any | None = None
        self._memory_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._memory_quota: dict[str, int] = {}

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
        if cache_hash.startswith(f"{cls.CACHE_PREFIX}:") or cache_hash.startswith(
            f"{cls.LEGACY_CACHE_PREFIX}:"
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
        user_key = self.build_user_quota_key(clean_user) if clean_user else ""
        ip_key = self.build_ip_quota_key(ip_address)
        user_limit = (
            self.resolve_user_limit(loyalty_tier, self.daily_limit) if clean_user else 0
        )
        ip_limit = self.auth_ip_limit if clean_user else self.guest_ip_limit
        return user_key, ip_key, user_limit, ip_limit

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
