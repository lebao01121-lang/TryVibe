from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from app.cache_quota.quota import TryOnCacheQuota
from app.config import Settings, get_settings
from app.preprocessing.normalizer import AspectRatioPreset, GarmentNormalizer
from app.providers.base import GarmentCategory, VTONProvider, VTONRequest
from app.providers.mock_provider import get_vton_provider, list_registered_providers

router = APIRouter(prefix="/api/v1/tryon", tags=["ai-tryon"])


class PreviewMockRequest(BaseModel):
    user_id: str = Field(default="guest-phase0", min_length=1, max_length=128)
    garment_sku_id: str = Field(default="AT-ALNL-IVR-S", min_length=1, max_length=128)
    garment_image_url: str = Field(
        default="minio://atelier-garments/AT-ALNL-IVR-S/front.webp",
        min_length=1,
    )
    person_image_fingerprint: str = Field(
        default="phase0-sample-portrait-sha256",
        min_length=4,
        max_length=256,
    )
    garment_category: GarmentCategory = "TOP"
    aspect_ratio: AspectRatioPreset = "2:3"
    garment_width: int = Field(default=720, gt=0)
    garment_height: int = Field(default=1080, gt=0)
    has_alpha: bool = True


def _get_runtime(request: Request) -> tuple[Settings, VTONProvider, GarmentNormalizer, TryOnCacheQuota]:
    state = request.app.state
    settings: Settings = getattr(state, "settings", None) or get_settings()
    provider: VTONProvider = getattr(state, "provider", None) or get_vton_provider(
        settings.vton_provider,
        private_bucket=settings.minio_bucket_private_tryon,
        purge_ttl_minutes=settings.tryon_purge_ttl_minutes,
        fal_key=settings.fal_key,
        fal_catvton_url=settings.fal_catvton_url,
        fal_timeout_seconds=settings.fal_timeout_seconds,
        hf_token=settings.hf_token,
        hf_vton_timeout_seconds=settings.hf_vton_timeout_seconds,
        hf_vton_enabled=settings.hf_vton_enabled,
    )
    normalizer: GarmentNormalizer = getattr(state, "normalizer", None) or GarmentNormalizer()
    cache_quota: TryOnCacheQuota = getattr(state, "cache_quota", None) or TryOnCacheQuota(
        redis_url=settings.redis_url,
        daily_limit=settings.tryon_daily_quota_per_user,
        cache_ttl_seconds=settings.tryon_cache_ttl_seconds,
    )
    return settings, provider, normalizer, cache_quota


@router.get("/providers")
async def get_providers(request: Request) -> dict[str, Any]:
    """List registered VTON providers and Phase 0 privacy/preprocessing policy."""
    settings, provider, _, _ = _get_runtime(request)
    correlation_id = getattr(request.state, "correlation_id", "")
    return {
        "activeProvider": provider.name,
        "configuredProvider": settings.vton_provider,
        "providers": list_registered_providers(active_provider=provider.name),
        "policy": {
            "allowedAspectRatios": ["2:3", "3:4"],
            "requireAlphaChannel": True,
            "privateBucket": settings.minio_bucket_private_tryon,
            "autoPurgeTtlMinutes": settings.tryon_purge_ttl_minutes,
            "dailyQuotaPerUser": settings.tryon_daily_quota_per_user,
        },
        "correlationId": correlation_id,
    }


async def _execute_preview_mock(
    request: Request,
    payload: PreviewMockRequest,
) -> dict[str, Any]:
    settings, provider, normalizer, cache_quota = _get_runtime(request)
    correlation_id = getattr(request.state, "correlation_id", "")

    validation = normalizer.validate_dimensions(
        payload.garment_width,
        payload.garment_height,
        has_alpha=payload.has_alpha,
        require_alpha=True,
        allowed_ratios=(payload.aspect_ratio,),
    )
    if not validation.valid:
        raise HTTPException(
            status_code=getattr(status, "HTTP_422_UNPROCESSABLE_CONTENT", 422),
            detail={
                "code": "GARMENT_PREPROCESSING_INVALID",
                "errors": validation.errors,
                "correlationId": correlation_id,
            },
        )

    plan = normalizer.build_normalization_plan(
        validation,
        default_preset=payload.aspect_ratio,
    )
    cache_key = cache_quota.compute_cache_key(
        person_fingerprint=payload.person_image_fingerprint,
        garment_sku_id=payload.garment_sku_id,
        garment_category=payload.garment_category,
        provider=provider.name,
        aspect_ratio=payload.aspect_ratio,
    )

    cached = await cache_quota.get_cached(cache_key)
    if cached is not None:
        return {
            "status": "COMPLETED",
            "cacheHit": True,
            "cacheKey": cache_key,
            "provider": provider.name,
            "result": cached,
            "normalization": {
                "preset": plan.preset,
                "targetWidth": plan.target_width,
                "targetHeight": plan.target_height,
                "safeMarginRatio": plan.safe_margin_ratio,
                "preserveAlpha": plan.preserve_alpha,
            },
            "correlationId": correlation_id,
        }

    quota = await cache_quota.consume_quota(
        payload.user_id,
        daily_limit=settings.tryon_daily_quota_per_user,
    )
    if not quota.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "TRYON_DAILY_QUOTA_EXCEEDED",
                "usedToday": quota.used_today,
                "dailyLimit": quota.daily_limit,
                "correlationId": correlation_id,
            },
        )

    vton_result = await provider.generate(
        VTONRequest(
            user_id=payload.user_id,
            garment_sku_id=payload.garment_sku_id,
            garment_image_url=payload.garment_image_url,
            person_image_fingerprint=payload.person_image_fingerprint,
            garment_category=payload.garment_category,
            aspect_ratio=payload.aspect_ratio,
            correlation_id=correlation_id,
        )
    )

    result_payload = {
        "jobId": vton_result.job_id,
        "provider": vton_result.provider,
        "status": vton_result.status,
        "resultBucket": vton_result.result_bucket,
        "resultObjectKey": vton_result.result_object_key,
        "previewUrl": vton_result.preview_url,
        "aspectRatio": vton_result.aspect_ratio,
        "latencyMs": vton_result.latency_ms,
        "createdAt": vton_result.created_at.isoformat(),
        "expiresAt": vton_result.expires_at.isoformat(),
        "notes": vton_result.notes,
    }
    cache_backend = await cache_quota.set_cached(cache_key, result_payload)

    return {
        "status": vton_result.status,
        "cacheHit": False,
        "cacheKey": cache_key,
        "cacheBackend": cache_backend,
        "provider": vton_result.provider,
        "quota": {
            "userId": quota.user_id,
            "usedToday": quota.used_today,
            "dailyLimit": quota.daily_limit,
            "remaining": quota.remaining,
            "backend": quota.backend,
        },
        "normalization": {
            "preset": plan.preset,
            "targetWidth": plan.target_width,
            "targetHeight": plan.target_height,
            "safeMarginRatio": plan.safe_margin_ratio,
            "preserveAlpha": plan.preserve_alpha,
        },
        "result": result_payload,
        "correlationId": correlation_id,
    }


@router.post("/preview-mock")
async def preview_mock_post(
    request: Request,
    payload: PreviewMockRequest,
) -> dict[str, Any]:
    """Phase 0 deterministic mock VTON preview endpoint."""
    return await _execute_preview_mock(request, payload)


@router.get("/preview-mock")
async def preview_mock_get(
    request: Request,
    user_id: str = Query(default="guest-phase0"),
    garment_sku_id: str = Query(default="AT-ALNL-IVR-S"),
    aspect_ratio: Literal["2:3", "3:4"] = Query(default="2:3"),
) -> dict[str, Any]:
    """Phase 0 quick smoke-test GET alias for deterministic mock VTON preview."""
    width, height = (720, 1080) if aspect_ratio == "2:3" else (768, 1024)
    payload = PreviewMockRequest(
        user_id=user_id,
        garment_sku_id=garment_sku_id,
        aspect_ratio=aspect_ratio,
        garment_width=width,
        garment_height=height,
    )
    return await _execute_preview_mock(request, payload)
