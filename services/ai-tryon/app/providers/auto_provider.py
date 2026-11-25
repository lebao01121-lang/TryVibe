from __future__ import annotations

import asyncio
import dataclasses
import logging
import time
from typing import Any

from app.providers.base import (
    BaseVtonProvider,
    PoseTooCloseError,
    ProviderCapabilities,
    TryOnGenerationRequest,
    TryOnGenerationResult,
    VTONProviderType,
    VTONRequest,
    VTONResult,
)
from app.providers.circuit_breaker import ProviderCircuitBreaker, is_quota_or_fatal_error
from app.providers.fal_provider import FalCatVtonProvider
from app.providers.fashn_provider import FashnVtonProvider
from app.providers.hf_gradio_provider import HuggingFaceZeroGpuVtonProvider
from app.providers.local_gpu_provider import LocalGpuVtonProvider
from app.providers.photometric_inpaint_provider import (
    PhotometricInpaintWarpProvider,
    resolve_bytes_or_url,
)

logger = logging.getLogger("atelier.ai_tryon.auto_provider")


class CompositeVtonRouter(BaseVtonProvider):
    """
    4-Tier Stage 2 VTON Orchestrator (`TRYON_PROVIDER=auto`, total budget <= 45s):
      0. Mandatory POSE_TOO_CLOSE gate BEFORE any remote API call (fast fail + quota refund)
      1. Tier 1 (Commercial Cloud, 4-8s):
           - FalCatVtonProvider (`FAL_KEY` non-empty)
           - FashnVtonProvider (`FASHN_API_KEY` non-empty)
      2. Tier 3 LAN Priority ($0, 100% private):
           - LocalGpuVtonProvider (`LOCAL_VTON_ENDPOINT` non-empty)
      3. Tier 2 ($0 Diffusion):
           - HuggingFaceZeroGpuVtonProvider (CatVTON -> IDM-VTON -> Kolors, D: drive temp only)
      4. Tier 4 (Immortal Anatomical Fallback — NEVER fails!):
           - PhotometricInpaintWarpProvider (INPAINT_TELEA + Clean Collar + TPS Cage + CIE-LAB)

    Every external tier & Space is protected by `ProviderCircuitBreaker` (180s cooldown).
    """

    name: str = "auto"
    provider_type: VTONProviderType = "PHOTOMETRIC_INPAINT"
    capabilities: ProviderCapabilities = ProviderCapabilities(
        name="auto",
        display_name="Atelier 4-Tier Composite VTON Router (Fal/Fashn -> LAN GPU -> HF ZeroGPU -> PhotometricInpaint)",
        mode="hybrid-auto",
        supported_categories=("TOP", "BOTTOM", "ONE_PIECE", "OUTERWEAR"),
        supported_aspect_ratios=("3:4", "2:3"),
        supports_alpha_cutout=True,
        status="active",
    )

    def __init__(
        self,
        *,
        fal_provider: FalCatVtonProvider | None = None,
        fashn_provider: FashnVtonProvider | None = None,
        local_gpu_provider: LocalGpuVtonProvider | None = None,
        hf_provider: HuggingFaceZeroGpuVtonProvider | None = None,
        photometric_provider: PhotometricInpaintWarpProvider | None = None,
        pose_warp_provider: Any | None = None,  # Backwards-compat alias
        circuit_breaker: ProviderCircuitBreaker | None = None,
        total_timeout_seconds: float = 45.0,
        circuit_breaker_seconds: int = 180,
        private_bucket: str = "atelier-private-tryon",
        purge_ttl_minutes: int = 15,
    ) -> None:
        self.circuit_breaker = circuit_breaker or ProviderCircuitBreaker(
            cooldown_seconds=float(circuit_breaker_seconds),
            failure_threshold=2,
        )
        self.fal_provider = fal_provider
        self.fashn_provider = fashn_provider
        self.local_gpu_provider = local_gpu_provider
        self.hf_provider = hf_provider
        if self.hf_provider is not None:
            # Share the same circuit breaker instance so /ready shows unified Space + Tier telemetry
            self.hf_provider.circuit_breaker = self.circuit_breaker

        resolved_tier4 = photometric_provider or (
            pose_warp_provider
            if isinstance(pose_warp_provider, PhotometricInpaintWarpProvider)
            else None
        ) or PhotometricInpaintWarpProvider(
            private_bucket=private_bucket,
            purge_ttl_minutes=purge_ttl_minutes,
        )
        self.photometric_provider: PhotometricInpaintWarpProvider = resolved_tier4
        self.pose_warp_provider = resolved_tier4  # Backwards-compat alias
        self.total_timeout_seconds = max(10.0, float(total_timeout_seconds))
        self.private_bucket = private_bucket
        self.purge_ttl_minutes = purge_ttl_minutes

        if self.fal_provider and self.fal_provider.fal_key:
            self.provider_type = "FAL_CATVTON"
        elif self.fashn_provider and self.fashn_provider.api_key:
            self.provider_type = "FASHN_VTON"
        elif self.local_gpu_provider and self.local_gpu_provider.endpoint_url:
            self.provider_type = "LOCAL_GPU_VTON"
        elif self.hf_provider and self.hf_provider.enabled:
            self.provider_type = "HF_GRADIO_VTON"
        else:
            self.provider_type = "PHOTOMETRIC_INPAINT"

    async def _try_external_tier(
        self,
        *,
        cb_key: str,
        provider: BaseVtonProvider,
        request: TryOnGenerationRequest,
        deadline: float,
        reserve_fallback_seconds: float = 5.0,
    ) -> TryOnGenerationResult | None:
        if not self.circuit_breaker.allow_request(cb_key):
            logger.debug(
                "Skipping %s (circuit OPEN, %.1fs remaining)",
                cb_key,
                self.circuit_breaker.remaining_cooldown_seconds(cb_key),
            )
            return None

        remaining = deadline - time.monotonic() - reserve_fallback_seconds
        if remaining <= 3.0:
            logger.warning(
                "Skipping %s: remaining budget %.1fs too low (reserving %.1fs for Tier 4)",
                cb_key,
                remaining,
                reserve_fallback_seconds,
            )
            return None

        tier_req = dataclasses.replace(
            request,
            timeout_seconds=min(float(request.timeout_seconds or remaining), remaining),
        )
        try:
            res = await asyncio.wait_for(provider.synthesize(tier_req), timeout=remaining + 0.5)
            self.circuit_breaker.record_success(cb_key)
            return res
        except PoseTooCloseError:
            raise
        except asyncio.TimeoutError:
            msg = f"{cb_key} timed out after {remaining:.1f}s"
            logger.warning("VTON tier timeout (%s); tripping circuit & falling back.", msg)
            self.circuit_breaker.record_failure(cb_key, msg, trip_immediately=True)
            return None
        except Exception as exc:
            msg = f"{exc.__class__.__name__}: {str(exc)[:220]}"
            logger.warning("VTON tier %s failed (%s); falling back.", cb_key, msg)
            self.circuit_breaker.record_failure(
                cb_key,
                msg,
                trip_immediately=is_quota_or_fatal_error(exc) or cb_key == "hf_gradio",
            )
            return None

    async def synthesize(self, request: TryOnGenerationRequest) -> TryOnGenerationResult:
        budget = min(
            self.total_timeout_seconds,
            float(request.timeout_seconds or self.total_timeout_seconds),
        )
        deadline = time.monotonic() + budget

        # Resolve person & garment bytes once so fallback tiers avoid duplicate network fetches
        person_bytes = await resolve_bytes_or_url(request.person_bytes, request.human_image_url)
        garment_bytes = await resolve_bytes_or_url(request.garment_bytes, request.garment_image_url)
        hydrated_req = dataclasses.replace(
            request,
            person_bytes=person_bytes,
            garment_bytes=garment_bytes,
        )

        # STEP 0 — Mandatory POSE_TOO_CLOSE gate BEFORE paid/remote tiers!
        precomputed_pose = await self.photometric_provider.validate_pose(
            person_bytes,
            pose_landmarks=hydrated_req.pose_landmarks,
        )

        # TIER 1A — fal.ai Cloud VTON (when FAL_KEY non-empty)
        if self.fal_provider is not None and self.fal_provider.fal_key:
            res = await self._try_external_tier(
                cb_key="fal",
                provider=self.fal_provider,
                request=hydrated_req,
                deadline=deadline,
            )
            if res is not None:
                return res

        # TIER 1B — FASHN.ai Cloud VTON (when FASHN_API_KEY non-empty)
        if self.fashn_provider is not None and self.fashn_provider.api_key:
            res = await self._try_external_tier(
                cb_key="fashn",
                provider=self.fashn_provider,
                request=hydrated_req,
                deadline=deadline,
            )
            if res is not None:
                return res

        # TIER 3 LAN Priority — Internal LAN GPU ($0, 100% private, when LOCAL_VTON_ENDPOINT set)
        if self.local_gpu_provider is not None and self.local_gpu_provider.endpoint_url:
            res = await self._try_external_tier(
                cb_key="local_gpu",
                provider=self.local_gpu_provider,
                request=hydrated_req,
                deadline=deadline,
            )
            if res is not None:
                return res

        # TIER 2 — HuggingFace ZeroGPU Spaces ($0 Diffusion, D: drive temp isolation)
        if self.hf_provider is not None and self.hf_provider.enabled:
            res = await self._try_external_tier(
                cb_key="hf_gradio",
                provider=self.hf_provider,
                request=hydrated_req,
                deadline=deadline,
                reserve_fallback_seconds=5.0,
            )
            if res is not None:
                return res

        # TIER 4 — Immortal PhotometricInpaintWarpProvider (NEVER fails!)
        return await self.photometric_provider.synthesize(
            hydrated_req,
            precomputed_pose=precomputed_pose,
        )

    def status_snapshot(self) -> dict[str, Any]:
        """Expose configured 4-tier chain & circuit breaker states for `/ready`."""
        return {
            "router": "CompositeVtonRouter",
            "activeDefaultProviderType": self.provider_type,
            "totalTimeoutSeconds": self.total_timeout_seconds,
            "tiers": {
                "tier1_fal": {
                    "configured": bool(self.fal_provider and self.fal_provider.fal_key),
                    "model": self.fal_provider.fal_vton_model if self.fal_provider else None,
                    "circuit": self.circuit_breaker.state("fal"),
                },
                "tier1_fashn": {
                    "configured": bool(self.fashn_provider and self.fashn_provider.api_key),
                    "circuit": self.circuit_breaker.state("fashn"),
                },
                "tier3_local_gpu": {
                    "configured": bool(
                        self.local_gpu_provider and self.local_gpu_provider.endpoint_url
                    ),
                    "circuit": self.circuit_breaker.state("local_gpu"),
                },
                "tier2_hf_zerogpu": {
                    "enabled": bool(self.hf_provider and self.hf_provider.enabled),
                    "spaces": list(self.hf_provider.spaces) if self.hf_provider else [],
                    "circuit": self.circuit_breaker.state("hf_gradio"),
                },
                "tier4_photometric_inpaint": {
                    "enabled": True,
                    "immortal": True,
                    "circuit": "CLOSED",
                },
            },
            "circuitBreaker": self.circuit_breaker.status_snapshot(),
        }

    async def _generate_legacy_preview(self, request: VTONRequest) -> VTONResult:
        return await self.photometric_provider._generate_legacy_preview(request)

    async def health_check(self) -> bool:
        return await self.photometric_provider.health_check()


# Backwards-compatible alias
AutoVTONProvider = CompositeVtonRouter
