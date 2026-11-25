from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

CircuitState = Literal["CLOSED", "OPEN", "HALF_OPEN"]

_IMMEDIATE_TRIP_PATTERNS: tuple[str, ...] = (
    "zerogpu",
    "gpu quota",
    "quota exceeded",
    "exceeded your gpu",
    "out of credits",
    "insufficient credits",
    "payment required",
    "402",
    "429",
    "too many requests",
    "401",
    "unauthorized",
    "403",
    "forbidden",
    "space is sleeping",
    "space is paused",
    "runtime error",
    "build error",
    "connection refused",
    "connecterror",
    "timed out",
    "timeout",
)


def is_quota_or_fatal_error(exc_or_msg: Exception | str) -> bool:
    """Detect quota exhaustion, auth/billing failure, dead Spaces, or timeouts that warrant immediate circuit trip."""
    text = f"{exc_or_msg.__class__.__name__}: {exc_or_msg}" if isinstance(exc_or_msg, Exception) else str(exc_or_msg)
    lowered = text.lower()
    return any(tok in lowered for tok in _IMMEDIATE_TRIP_PATTERNS)


@dataclass
class _CircuitEntry:
    consecutive_failures: int = 0
    total_failures: int = 0
    total_successes: int = 0
    opened_at_mono: float | None = None
    tripped_until_mono: float | None = None
    tripped_until_iso: str | None = None
    last_error: str | None = None
    last_failure_iso: str | None = None
    last_success_iso: str | None = None


class ProviderCircuitBreaker:
    """
    Thread-safe per-provider / per-space circuit breaker.
    Trips OPEN for `cooldown_seconds` (default 180s = 3 minutes) after consecutive failures
    or immediately upon quota exhaustion / timeout / unreachable upstream so users never stall.
    """

    def __init__(
        self,
        *,
        cooldown_seconds: float = 180.0,
        failure_threshold: int = 2,
    ) -> None:
        self.cooldown_seconds = max(15.0, float(cooldown_seconds))
        self.failure_threshold = max(1, int(failure_threshold))
        self._lock = threading.Lock()
        self._entries: dict[str, _CircuitEntry] = {}

    def _entry(self, key: str) -> _CircuitEntry:
        norm = key.strip().lower()
        entry = self._entries.get(norm)
        if entry is None:
            entry = _CircuitEntry()
            self._entries[norm] = entry
        return entry

    def state(self, key: str) -> CircuitState:
        with self._lock:
            entry = self._entries.get(key.strip().lower())
            if entry is None or entry.tripped_until_mono is None:
                return "CLOSED"
            if time.monotonic() < entry.tripped_until_mono:
                return "OPEN"
            return "HALF_OPEN"

    def is_open(self, key: str) -> bool:
        return self.state(key) == "OPEN"

    def allow_request(self, key: str) -> bool:
        return not self.is_open(key)

    def remaining_cooldown_seconds(self, key: str) -> float:
        with self._lock:
            entry = self._entries.get(key.strip().lower())
            if entry is None or entry.tripped_until_mono is None:
                return 0.0
            rem = entry.tripped_until_mono - time.monotonic()
            return max(0.0, round(rem, 1))

    def record_success(self, key: str) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._lock:
            entry = self._entry(key)
            entry.consecutive_failures = 0
            entry.total_successes += 1
            entry.opened_at_mono = None
            entry.tripped_until_mono = None
            entry.tripped_until_iso = None
            entry.last_error = None
            entry.last_success_iso = now_iso

    def record_failure(
        self,
        key: str,
        reason: str = "",
        *,
        trip_immediately: bool = False,
        cooldown_override: float | None = None,
    ) -> bool:
        """
        Record a failure for `key`. Returns True if the circuit is now OPEN.
        """
        now_mono = time.monotonic()
        now_utc = datetime.now(timezone.utc)
        short_reason = (reason or "unknown_error").strip()[:280]
        should_trip_now = trip_immediately or is_quota_or_fatal_error(short_reason)

        with self._lock:
            entry = self._entry(key)
            entry.consecutive_failures += 1
            entry.total_failures += 1
            entry.last_error = short_reason
            entry.last_failure_iso = now_utc.isoformat()

            if should_trip_now or entry.consecutive_failures >= self.failure_threshold:
                cd = (
                    max(15.0, float(cooldown_override))
                    if cooldown_override is not None
                    else self.cooldown_seconds
                )
                entry.opened_at_mono = now_mono
                entry.tripped_until_mono = now_mono + cd
                entry.tripped_until_iso = (now_utc + timedelta(seconds=cd)).isoformat()
                return True
            return False

    def reset(self, key: str | None = None) -> None:
        with self._lock:
            if key is None:
                self._entries.clear()
            else:
                self._entries.pop(key.strip().lower(), None)

    def status_snapshot(self) -> dict[str, Any]:
        """Return JSON-serializable circuit breaker telemetry for `/ready`."""
        now_mono = time.monotonic()
        providers_snap: dict[str, Any] = {}
        with self._lock:
            for key, entry in sorted(self._entries.items()):
                if entry.tripped_until_mono is None:
                    cur_state: CircuitState = "CLOSED"
                    remaining = 0.0
                elif now_mono < entry.tripped_until_mono:
                    cur_state = "OPEN"
                    remaining = round(entry.tripped_until_mono - now_mono, 1)
                else:
                    cur_state = "HALF_OPEN"
                    remaining = 0.0

                providers_snap[key] = {
                    "state": cur_state,
                    "consecutiveFailures": entry.consecutive_failures,
                    "totalFailures": entry.total_failures,
                    "totalSuccesses": entry.total_successes,
                    "remainingCooldownSeconds": remaining,
                    "trippedUntil": entry.tripped_until_iso if cur_state == "OPEN" else None,
                    "lastError": entry.last_error,
                    "lastFailureAt": entry.last_failure_iso,
                    "lastSuccessAt": entry.last_success_iso,
                }

        return {
            "cooldownSeconds": int(self.cooldown_seconds),
            "failureThreshold": self.failure_threshold,
            "providers": providers_snap,
        }
