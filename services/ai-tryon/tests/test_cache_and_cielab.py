from __future__ import annotations

import base64
import io
import time
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import cv2
import numpy as np
import pytest
from PIL import Image

from app.api.tryon_v1 import _apply_photometric_slot_recolor
from app.cache_quota.quota import (
    TryOnCacheQuota,
    compute_session_cache_hash,
    compute_v2_cache_key,
    compute_v2_step1_cache_key,
    format_garment_variant_pair,
    normalize_garment_slot,
    sort_garments_physically,
)
from app.providers.auto_provider import CompositeVtonRouter
from app.providers.base import (
    CACHE_HIT_BADGE,
    GENERATIVE_VTON_BADGE,
    PHOTOMETRIC_INPAINT_BADGE,
    PoseTooCloseError,
    TryOnGenerationRequest,
    TryOnGenerationResult,
    VTONRequest,
    build_english_garment_prompt,
    cloth_type_to_step_category,
    get_provider_display_badge,
    normalize_cloth_type,
    normalize_lighting_preset,
)
from app.providers.circuit_breaker import ProviderCircuitBreaker, is_quota_or_fatal_error
from app.providers.fal_provider import FalCatVtonProvider
from app.providers.fashn_provider import FashnVtonProvider
from app.providers.hf_gradio_provider import (
    HuggingFaceZeroGpuVtonProvider,
    _extract_result_path,
)
from app.providers.local_gpu_provider import LocalGpuVtonProvider
from app.providers.mock_provider import (
    MockVTONProvider,
    get_vton_provider,
    list_registered_providers,
)
from app.providers import photometric_inpaint_provider as pip_mod
from app.providers import smart_pose_warp_provider as spw_mod

from tests.conftest import (
    StubSuccessVtonProvider,
    make_image_bytes,
    make_mediapipe_33_landmarks,
    make_synthetic_garment_rgba_bytes,
    make_synthetic_person_mask,
    make_synthetic_portrait_bytes,
    make_valid_pose_landmarks,
)


# =============================================================================
# 1. SHA-256 Cache Key Determinism & Physical Garment Ordering
# =============================================================================


class TestCacheKeyAndQuota:
    def test_step1_and_v2_cache_key_determinism(self) -> None:
        person_sha = "a" * 64
        top_a = {
            "slot": "TOP",
            "productId": "prod-cashmere-01",
            "variantId": "var-ivory-s",
            "colorHex": "#F5EFE6",
        }
        top_b = {
            "slot": "upper",
            "productId": "prod-cashmere-01",
            "variantId": "var-cocoa-s",
            "colorHex": "#4A3728",
        }
        bottom = {
            "slot": "BOTTOM",
            "productId": "prod-trouser-01",
            "variantId": "var-charcoal-m",
            "colorHex": "#2C2E33",
        }
        outer = {
            "slot": "OUTERWEAR",
            "productId": "prod-blazer-01",
            "variantId": "var-camel-m",
        }

        # Identical person + garment + lighting -> identical SHA-256 Step 1 key
        k1 = compute_v2_step1_cache_key(
            person_frame_sha256=person_sha,
            step1_garment=top_a,
            lighting_preset="atelier",
        )
        k1_repeat = compute_v2_step1_cache_key(
            person_frame_sha256=person_sha.upper(),
            step1_garment=dict(top_a),
            lighting_preset="ATELIER",
        )
        assert k1 == k1_repeat
        assert k1.startswith("tryon:v2:step1:")
        assert len(k1.split(":")[-1]) == 64

        # Different lighting -> distinct key
        k_morning = compute_v2_step1_cache_key(
            person_frame_sha256=person_sha,
            step1_garment=top_a,
            lighting_preset="morning",
        )
        k_evening = compute_v2_step1_cache_key(
            person_frame_sha256=person_sha,
            step1_garment=top_a,
            lighting_preset="evening",
        )
        assert len({k1, k_morning, k_evening}) == 3

        # Different garment/variant -> distinct key
        k_other_garment = compute_v2_step1_cache_key(
            person_frame_sha256=person_sha,
            step1_garment=top_b,
            lighting_preset="atelier",
        )
        assert k_other_garment != k1

        # compute_v2_cache_key is permutation-invariant via physical layering sort
        key_perm_1 = compute_v2_cache_key(
            person_frame_sha256=person_sha,
            garments=[outer, bottom, top_a],
            lighting_preset="atelier",
        )
        key_perm_2 = compute_v2_cache_key(
            person_frame_sha256=person_sha,
            garments=[top_a, outer, bottom],
            lighting_preset="atelier",
        )
        assert key_perm_1 == key_perm_2
        assert key_perm_1.startswith("tryon:v2:")

        # Legacy hash helper & image_url fallback when variantId absent
        pair_url = format_garment_variant_pair(
            {"slot": "shirt", "productId": "p1", "garmentImageUrl": "https://cdn.local/g.png"}
        )
        assert pair_url.startswith("upper:p1::")
        legacy_h = compute_session_cache_hash(
            sha256_hash=person_sha,
            mode="MIX_MATCH_OUTFIT",
            upper_product_id="p1",
            lower_product_id="p2",
        )
        assert len(legacy_h) == 64

    def test_sort_garments_physically_layering_order(self) -> None:
        assert normalize_garment_slot("TOP") == "upper"
        assert normalize_garment_slot("blouse") == "upper"
        assert normalize_garment_slot("BOTTOM") == "lower"
        assert normalize_garment_slot("skirt") == "lower"
        assert normalize_garment_slot("ONE_PIECE") == "onePiece"
        assert normalize_garment_slot("dress") == "onePiece"
        assert normalize_garment_slot("OUTERWEAR") == "outerwear"
        assert normalize_garment_slot("blazer") == "outerwear"
        assert normalize_garment_slot("accessory") == "accessory"
        assert normalize_garment_slot("unknown_slot") == "upper"

        scrambled = [
            {"slot": "accessory", "productId": "acc-1"},
            {"slot": "OUTERWEAR", "productId": "coat-1"},
            {"slot": "BOTTOM", "productId": "pants-1"},
            {"slot": "ONE_PIECE", "productId": "dress-1"},
            {"slot": "TOP", "productId": "top-1"},
        ]
        ordered = sort_garments_physically(scrambled)
        ordered_slots = [normalize_garment_slot(g["slot"]) for g in ordered]
        # ONE_PIECE and UPPER both have priority 1 ("onepiece" < "upper" alphabetically),
        # followed strictly by LOWER (2) -> OUTERWEAR (3) -> ACCESSORY (4)
        assert ordered_slots[:2] == ["onePiece", "upper"]
        assert ordered_slots[2:] == ["lower", "outerwear", "accessory"]

    async def test_cache_quota_memory_and_mocked_redis_paths(
        self, memory_cache_quota: TryOnCacheQuota
    ) -> None:
        cq = memory_cache_quota
        assert cq.resolve_user_limit("BRONZE") == 10
        assert cq.resolve_user_limit("SILVER") == 12
        assert cq.resolve_user_limit("GOLD") == 15
        assert cq.resolve_user_limit("DIAMOND") == 25
        assert cq.resolve_user_limit(None, default_limit=8) == 8
        assert cq.build_cache_redis_key("abc") == "tryon:cache:abc"
        assert cq.build_cache_redis_key("tryon:v2:abc") == "tryon:v2:abc"
        assert "tryon:quota:week:" in cq.build_weekly_quota_key("user:u1")
        assert cq.build_quota_key("u1") == cq.build_user_quota_key("u1")
        assert cq.compute_cache_key(person_fingerprint="fp", garment_sku_id="sku").startswith(
            "atelier:tryon:cache:"
        )
        assert await cq.ping() is False

        # Cache CRUD + expiration
        backend = await cq.set_cached("k-test", {"url": "http://x"}, ttl_seconds=60)
        assert backend == "memory-fallback"
        assert (await cq.get_cached("k-test")) == {"url": "http://x"}
        assert await cq.delete_cached("k-test") is True
        assert await cq.get_cached("k-test") is None

        # Job state & cancel flags
        await cq.set_job_state("j1", {"status": "PROCESSING"})
        assert (await cq.get_job_state("j1")) == {"status": "PROCESSING"}
        await cq.delete_job_state("j1")
        assert await cq.get_job_state("j1") is None

        assert await cq.is_job_cancelled("j2") is False
        await cq.mark_job_cancelled("j2")
        assert await cq.is_job_cancelled("j2") is True

        # Dual quota deduction, exhaustion, and idempotent refund
        for _ in range(5):
            snap = await cq.deduct_dual_quota(user_id=None, ip_address="198.51.100.99")
            assert snap.allowed is True
        blocked_ip = await cq.deduct_dual_quota(user_id=None, ip_address="198.51.100.99")
        assert blocked_ip.allowed is False and blocked_ip.reason == "IP_QUOTA_EXCEEDED"

        # Authenticated user hitting user daily limit
        cq_small = TryOnCacheQuota(
            redis_url="redis://127.0.0.1:1/0",
            daily_limit=2,
            guest_ip_limit=5,
            auth_ip_limit=30,
            is_production=False,
        )
        async def _no_r() -> None:
            return None
        cq_small._get_redis = _no_r  # type: ignore[method-assign]

        d1 = await cq_small.consume_quota("u-lim", daily_limit=2)
        d2 = await cq_small.consume_quota("u-lim", daily_limit=2)
        d3 = await cq_small.consume_quota("u-lim", daily_limit=2)
        assert d1.allowed and d2.allowed and not d3.allowed

        # Idempotent refund_quota with job_id only refunds ONCE
        r1 = await cq_small.refund_quota("u-lim", "127.0.0.1", job_id="job-idemp")
        r2 = await cq_small.refund_quota("u-lim", "127.0.0.1", job_id="job-idemp")
        assert r1.used_today == 1 and r2.used_today == 1

        # Mocked Redis client exercising Redis branches (get/set/delete/eval/ping/close)
        fake_redis = MagicMock()
        store: dict[str, str] = {}
        fake_redis.ping = AsyncMock(return_value=True)
        fake_redis.get = AsyncMock(side_effect=lambda k: store.get(k))
        async def _rset(k: str, v: str, ex: int | None = None, nx: bool = False) -> bool:
            if nx and k in store:
                return False
            store[k] = v
            return True
        fake_redis.set = AsyncMock(side_effect=_rset)
        fake_redis.delete = AsyncMock(side_effect=lambda k: store.pop(k, None))
        fake_redis.eval = AsyncMock(side_effect=[[1, 9, 29], [0, "USER_QUOTA_EXCEEDED", 0, 20], [1]])
        fake_redis.aclose = AsyncMock()

        cq_redis = TryOnCacheQuota(redis_url="redis://127.0.0.1:6379/0")
        cq_redis._redis_client = fake_redis
        assert await cq_redis.ping() is True
        assert await cq_redis.set_cached("rk1", {"ok": True}) == "redis"
        assert await cq_redis.get_cached("rk1") == {"ok": True}
        assert await cq_redis.delete_cached("rk1") is True
        await cq_redis.set_job_state("rj1", {"p": 50})
        assert await cq_redis.get_job_state("rj1") == {"p": 50}
        await cq_redis.delete_job_state("rj1")
        await cq_redis.mark_job_cancelled("rj2")
        assert await cq_redis.is_job_cancelled("rj2") is True

        snap_ok = await cq_redis.deduct_dual_quota(user_id="ru1", ip_address="10.0.0.1")
        assert snap_ok.allowed is True and snap_ok.backend == "redis"
        snap_deny = await cq_redis.deduct_dual_quota(user_id="ru1", ip_address="10.0.0.1")
        assert snap_deny.allowed is False and snap_deny.reason == "USER_QUOTA_EXCEEDED"
        snap_ref = await cq_redis.refund_quota("ru1", "10.0.0.1", job_id="rj-refund")
        assert snap_ref.backend == "redis"
        await cq_redis.close()
        fake_redis.aclose.assert_awaited_once()


# =============================================================================
# 2. Optical CIE-LAB Color/Lighting Transfer, Harmonization & Photometric Render
# =============================================================================


class TestCieLabHarmonizationAndProviders:
    def test_cie_lab_lighting_preset_shift_preserves_768x1024_and_no_nan(self) -> None:
        h, w = 1024, 768
        # Warm neutral studio portrait & neutral mid-grey garment
        person_rgb = np.full((h, w, 3), (180, 175, 168), dtype=np.uint8)
        warped_rgb = np.full((h, w, 3), (140, 140, 140), dtype=np.uint8)
        alpha_f = np.zeros((h, w), dtype=np.float32)
        alpha_f[260:780, 210:560] = 1.0
        person_mask = np.zeros((h, w), dtype=bool)
        person_mask[100:960, 180:590] = True
        rect = (210.0, 260.0, 350.0, 520.0)

        morning_out = pip_mod._shade_and_relight_garment_lab(
            person_rgb, warped_rgb, alpha_f, person_mask, rect, "morning"
        )
        atelier_out = pip_mod._shade_and_relight_garment_lab(
            person_rgb, warped_rgb, alpha_f, person_mask, rect, "atelier"
        )
        evening_out = pip_mod._shade_and_relight_garment_lab(
            person_rgb, warped_rgb, alpha_f, person_mask, rect, "evening"
        )

        for img in (morning_out, atelier_out, evening_out):
            assert img.shape == (1024, 768, 3)
            assert np.isfinite(img).all()
            assert float(img.min()) >= 0.0 and float(img.max()) <= 255.0

        # Convert center garment ROI to CIE-LAB and verify directional L* & b* shifts
        roi = (slice(360, 620), slice(280, 480))
        lab_morning = cv2.cvtColor(morning_out[roi].astype(np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32)
        lab_atelier = cv2.cvtColor(atelier_out[roi].astype(np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32)
        lab_evening = cv2.cvtColor(evening_out[roi].astype(np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32)

        # Morning must be brighter (higher L*) than atelier and evening; evening warmer (higher b*)
        assert float(lab_morning[:, :, 0].mean()) > float(lab_atelier[:, :, 0].mean())
        assert float(lab_atelier[:, :, 0].mean()) > float(lab_evening[:, :, 0].mean())
        assert float(lab_evening[:, :, 2].mean()) > float(lab_atelier[:, :, 2].mean())

        # Studio atmosphere pass preserves exact shape & finite bounds across all presets
        for preset in ("morning", "atelier", "evening"):
            atmo = pip_mod._apply_studio_atmosphere_pass(atelier_out, preset)  # type: ignore[arg-type]
            assert atmo.shape == (1024, 768, 3) and np.isfinite(atmo).all()

    def test_photometric_slot_recolor_cie_lab_preserves_alpha_and_shifts_color(self) -> None:
        h, w = 1024, 768
        # Neutral ivory base garment with shading gradient
        grad = np.linspace(140, 220, h, dtype=np.float32)[:, None]
        base_bgr = np.repeat(np.repeat(grad[:, :, None], w, axis=1), 3, axis=2)
        orig_lab = cv2.cvtColor(base_bgr.astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)

        mask_alpha = np.zeros((h, w), dtype=np.float32)
        mask_alpha[240:760, 200:568] = 1.0

        # Recolor to deep burgundy (#6E1D2A) across silk, linen, tweed, leather
        for sheen in ("silk", "linen", "tweed", "leather"):
            recolored = _apply_photometric_slot_recolor(
                base_bgr.copy(),
                orig_lab,
                mask_alpha,
                color_hex="#6E1D2A",
                profile={"sheen": sheen, "specularIntensity": 0.42, "shadowDepth": 0.34},
            )
            assert recolored.shape == (1024, 768, 3)
            assert np.isfinite(recolored).all()
            # Pixels strictly outside mask_alpha == 0 are completely preserved
            assert np.allclose(recolored[0:100, 0:100], base_bgr[0:100, 0:100], atol=1e-4)
            # Inside mask, CIE-LAB shifts significantly toward burgundy (higher a* red channel, lower L*)
            recolored_lab = cv2.cvtColor(
                np.clip(recolored, 0, 255).astype(np.uint8), cv2.COLOR_BGR2LAB
            ).astype(np.float32)
            assert float(recolored_lab[400:600, 300:460, 1].mean()) > 140.0  # strong red a* shift
            assert float(recolored_lab[400:600, 300:460, 0].mean()) < float(
                orig_lab[400:600, 300:460, 0].mean()
            )

        # SmartPoseWarp LAB ambient luminance match
        p_bright = np.full((256, 192, 3), 230, dtype=np.uint8)
        g_dark = np.full((256, 192, 3), 100, dtype=np.uint8)
        g_alpha = np.full((256, 192), 255, dtype=np.uint8)
        pmask = np.ones((256, 192), dtype=bool)
        matched = spw_mod._match_ambient_lighting_lab(p_bright, g_dark, g_alpha, pmask)
        assert matched.shape == (256, 192, 3)
        assert float(matched.mean()) > float(g_dark.mean())

    async def test_garment_prep_and_full_photometric_and_smart_warp_renders(self) -> None:
        # 1) Garment prep with opaque white bg, dark collar cavity, and variant recoloring (dark + light)
        garment_white_cavity = make_synthetic_garment_rgba_bytes(
            rgb=(230, 222, 208),
            with_dark_collar_cavity=True,
            opaque_white_bg=True,
        )
        with patch.object(pip_mod, "_get_rembg_general_session", return_value=None):
            prep_dark = pip_mod.prepare_clean_garment_rgba(
                garment_white_cavity, cloth_type="upper", color_hex="#3A271E"
            )
            assert prep_dark.rgba.shape[2] == 4
            assert prep_dark.anchors.right_shoulder_x > prep_dark.anchors.left_shoulder_x

            # Studio white composite & 768x1024 output normalizer
            studio_png, _ = pip_mod.composite_garment_studio_white(
                garment_white_cavity, cloth_type="upper", color_hex="#E8DCC8", output_format="PNG"
            )
            with Image.open(io.BytesIO(studio_png)) as im:
                assert im.size == (768, 1024)

            norm_webp = pip_mod.normalize_output_768x1024(
                make_image_bytes(width=400, height=500, fmt="PNG"), fmt="WEBP"
            )
            with Image.open(io.BytesIO(norm_webp)) as im2:
                assert im2.size == (768, 1024)

        # 2) Full PhotometricInpaintWarpProvider synthesis across upper, lower (step 1 & 2), overall, outerwear
        portrait_bytes = make_synthetic_portrait_bytes()
        garment_rgba = make_synthetic_garment_rgba_bytes(rgb=(215, 202, 184))
        person_mask = make_synthetic_person_mask()
        landmarks = make_mediapipe_33_landmarks()

        provider = pip_mod.PhotometricInpaintWarpProvider()
        with (
            patch.object(pip_mod, "_get_rembg_general_session", return_value=None),
            patch.object(pip_mod, "_get_rembg_cloth_session", return_value=None),
            patch.object(pip_mod, "_extract_person_silhouette", return_value=person_mask),
            patch.object(
                pip_mod,
                "_detect_primary_face",
                return_value=((320, 90, 128, 145), 240.0, (384.0, 165.0)),
            ),
        ):
            for cloth_type, preset, step_order, gname in (
                ("upper", "atelier", 1, "Áo Len Cashmere Cổ Lọ"),
                ("lower", "morning", 1, "Quần Tây Ống Suông"),
                ("lower", "evening", 2, "Quần Tây Ống Suông"),
                ("overall", "atelier", 1, "Đầm Lụa Tơ Tằm"),
                ("outerwear", "evening", 2, "Áo Khoác Blazer Tweed"),
            ):
                res = await provider.synthesize(
                    TryOnGenerationRequest(
                        person_bytes=portrait_bytes,
                        garment_bytes=garment_rgba,
                        cloth_type=cloth_type,
                        garment_name=gname,
                        lighting_preset=preset,
                        pose_landmarks=landmarks,
                        step_order=step_order,
                        total_steps=2 if step_order == 2 else 1,
                    )
                )
                assert (res.width, res.height) == (768, 1024)
                assert res.provider_type == "PHOTOMETRIC_INPAINT"
                with Image.open(io.BytesIO(res.result_bytes)) as out_im:
                    assert out_im.size == (768, 1024)

            # Legacy preview & health check
            legacy = await provider.generate(
                VTONRequest(
                    user_id="u1",
                    garment_sku_id="SKU-1",
                    garment_image_url="minio://atelier-garments/s.png",
                    person_image_fingerprint="fp1",
                )
            )
            assert legacy.status == "COMPLETED"
            assert await provider.health_check() is True

        # 3) SmartPoseWarpVTONProvider render_step across UPPER, LOWER, OVERALL
        spw = spw_mod.SmartPoseWarpVTONProvider()
        with (
            patch.object(spw_mod, "_extract_person_silhouette", return_value=person_mask),
            patch.object(
                spw_mod,
                "_detect_primary_face",
                return_value=((320, 90, 128, 145), 240),
            ),
            patch.object(spw_mod, "_detect_mediapipe_pose", return_value=None),
        ):
            for cat in ("UPPER", "LOWER", "OVERALL"):
                step_out = await spw.render_step(
                    person_image_bytes=portrait_bytes,
                    garment_image_bytes=garment_rgba,
                    garment_image_url=None,
                    garment_category=cat,  # type: ignore[arg-type]
                    pose_landmarks=make_valid_pose_landmarks(),
                )
                assert step_out.provider_type == "SMART_POSE_WARP"
                with Image.open(io.BytesIO(step_out.image_bytes)) as im_spw:
                    assert im_spw.size == (768, 1024)
            assert await spw.health_check() is True
            spw_prev = await spw.generate(
                VTONRequest(
                    user_id="u1",
                    garment_sku_id="SKU-2",
                    garment_image_url="",
                    person_image_fingerprint="fp2",
                )
            )
            assert spw_prev.status == "COMPLETED"


# =============================================================================
# 3. Provider Helpers, Circuit Breaker, 4-Tier Router & Remote Adapters
# =============================================================================


class TestProviderRouterAndAdapters:
    def test_base_helpers_and_circuit_breaker(self) -> None:
        assert normalize_cloth_type("BOTTOMS") == "lower"
        assert normalize_cloth_type("dress") == "overall"
        assert normalize_cloth_type("blazer") == "outerwear"
        assert normalize_cloth_type("top") == "upper"
        assert cloth_type_to_step_category("lower") == "LOWER"
        assert cloth_type_to_step_category("overall") == "OVERALL"
        assert cloth_type_to_step_category("upper") == "UPPER"
        assert normalize_lighting_preset("morning") == "morning"
        assert normalize_lighting_preset("evening") == "evening"
        assert normalize_lighting_preset("other") == "atelier"
        assert get_provider_display_badge("FAL_CATVTON") == GENERATIVE_VTON_BADGE
        assert get_provider_display_badge("CACHE_HIT") == CACHE_HIT_BADGE
        assert get_provider_display_badge(None) == PHOTOMETRIC_INPAINT_BADGE

        prompt = build_english_garment_prompt(
            garment_name="Áo Len Cashmere Cổ Lọ Kem Cashmere",
            cloth_type="upper",
            color_hex="#F5EFE6",
        )
        assert "ivory" in prompt and "cashmere" in prompt and "turtleneck" in prompt
        prompt_hex = build_english_garment_prompt(garment_name="", cloth_type="lower", color_hex="#181818")
        assert "black" in prompt_hex and "trousers" in prompt_hex

        assert is_quota_or_fatal_error("ZeroGPU quota exceeded (429)") is True
        assert is_quota_or_fatal_error("transient blip") is False

        cb = ProviderCircuitBreaker(cooldown_seconds=15.0, failure_threshold=2)
        assert cb.state("fal") == "CLOSED" and cb.allow_request("fal") is True
        assert cb.record_failure("fal", "soft err") is False
        assert cb.record_failure("fal", "soft err 2") is True
        assert cb.state("fal") == "OPEN" and cb.is_open("fal") is True
        assert cb.remaining_cooldown_seconds("fal") > 0
        snap = cb.status_snapshot()
        assert snap["providers"]["fal"]["state"] == "OPEN"

        # Simulate cooldown expiry -> HALF_OPEN -> record_success -> CLOSED
        cb._entries["fal"].tripped_until_mono = time.monotonic() - 1.0
        assert cb.state("fal") == "HALF_OPEN"
        cb.record_success("fal")
        assert cb.state("fal") == "CLOSED"
        cb.reset("fal")
        cb.reset()

    async def test_composite_router_4tier_fallback_and_factory(self) -> None:
        portrait_bytes = make_synthetic_portrait_bytes()
        garment_bytes = make_synthetic_garment_rgba_bytes()

        # PoseTooCloseError at Step 0 MUST abort before touching Tier 1/2/3!
        tier1 = StubSuccessVtonProvider()
        tier1.fal_key = "test-fal-key"  # type: ignore[attr-defined]
        tier4 = MagicMock(spec=pip_mod.PhotometricInpaintWarpProvider)
        tier4.validate_pose = AsyncMock(side_effect=PoseTooCloseError("Close-up rejected"))
        tier4.synthesize = AsyncMock()
        tier4.health_check = AsyncMock(return_value=True)

        router_pose = CompositeVtonRouter(
            fal_provider=tier1,  # type: ignore[arg-type]
            photometric_provider=tier4,
        )
        with pytest.raises(PoseTooCloseError):
            await router_pose.synthesize(
                TryOnGenerationRequest(person_bytes=portrait_bytes, garment_bytes=garment_bytes)
            )
        assert len(tier1.calls) == 0  # Tier 1 was NEVER billed/called!

        # Tier 1 fails -> Tier 1B fails -> Tier 3 fails -> Tier 2 fails -> Tier 4 immortal succeeds!
        failing_fal = StubSuccessVtonProvider(error=RuntimeError("429 quota exceeded"))
        failing_fal.fal_key = "k-fal"  # type: ignore[attr-defined]
        failing_fal.fal_vton_model = "fal-ai/cat-vton"  # type: ignore[attr-defined]

        failing_fashn = StubSuccessVtonProvider(error=RuntimeError("FASHN 503"))
        failing_fashn.api_key = "k-fashn"  # type: ignore[attr-defined]

        failing_gpu = StubSuccessVtonProvider(error=RuntimeError("connection refused"))
        failing_gpu.endpoint_url = "http://10.0.0.5:8000"  # type: ignore[attr-defined]

        failing_hf = StubSuccessVtonProvider(error=RuntimeError("space is sleeping"))
        failing_hf.enabled = True  # type: ignore[attr-defined]
        failing_hf.spaces = ("zhengchong/CatVTON",)  # type: ignore[attr-defined]

        tier4_ok = StubSuccessVtonProvider()
        tier4_ok.validate_pose = AsyncMock(return_value=(None, None))  # type: ignore[attr-defined]

        router = CompositeVtonRouter(
            fal_provider=failing_fal,  # type: ignore[arg-type]
            fashn_provider=failing_fashn,  # type: ignore[arg-type]
            local_gpu_provider=failing_gpu,  # type: ignore[arg-type]
            hf_provider=failing_hf,  # type: ignore[arg-type]
            photometric_provider=tier4_ok,  # type: ignore[arg-type]
        )
        res = await router.synthesize(
            TryOnGenerationRequest(person_bytes=portrait_bytes, garment_bytes=garment_bytes)
        )
        assert res.provider_type == "PHOTOMETRIC_INPAINT"
        assert router.circuit_breaker.is_open("fal") is True
        assert router.circuit_breaker.is_open("local_gpu") is True
        assert router.circuit_breaker.is_open("hf_gradio") is True
        status_snap = router.status_snapshot()
        assert status_snap["tiers"]["tier4_photometric_inpaint"]["immortal"] is True
        assert await router.health_check() is True

        # Provider registry & factory variants
        assert len(list_registered_providers("auto")) == 6
        assert isinstance(get_vton_provider("photometric"), pip_mod.PhotometricInpaintWarpProvider)
        assert isinstance(get_vton_provider("fal", fal_key="fk"), CompositeVtonRouter)
        assert isinstance(get_vton_provider("fashn", fashn_api_key="fk"), CompositeVtonRouter)
        assert isinstance(get_vton_provider("local_gpu", local_vton_endpoint="http://x"), CompositeVtonRouter)
        assert isinstance(get_vton_provider("hf_gradio", hf_vton_enabled=True), CompositeVtonRouter)
        assert isinstance(get_vton_provider("auto", hf_vton_enabled=False), CompositeVtonRouter)

        mock_p = MockVTONProvider()
        assert await mock_p.health_check() is True

    async def test_remote_providers_with_mocked_http_and_gradio(self, tmp_path: Path) -> None:
        person_b = make_synthetic_portrait_bytes()
        garment_b = make_synthetic_garment_rgba_bytes()
        webp_out = make_image_bytes(width=768, height=1024, fmt="WEBP")
        req = TryOnGenerationRequest(
            person_bytes=person_b,
            garment_bytes=garment_b,
            cloth_type="upper",
            garment_name="Áo Lụa",
        )

        # 1) FalCatVtonProvider payload variants + queue polling
        fal_idm = FalCatVtonProvider(fal_key="fk", fal_vton_model="fal-ai/idm-vton")
        assert fal_idm._build_payload(
            human_uri="h", garment_uri="g", cloth_type="lower", english_prompt="p"
        )["category"] == "lower_body"
        fal_leffa = FalCatVtonProvider(fal_key="fk", fal_vton_model="fal-ai/leffa")
        assert fal_leffa._build_payload(
            human_uri="h", garment_uri="g", cloth_type="overall", english_prompt="p"
        )["garment_type"] == "dresses"
        assert FalCatVtonProvider._extract_output_image_url({"output": {"images": [{"url": "https://img"}]}}) == "https://img"

        fal = FalCatVtonProvider(fal_key="fk")
        mock_client = AsyncMock()
        post_r = MagicMock(status_code=200)
        post_r.json.return_value = {"request_id": "req-1", "status_url": "https://s", "response_url": "https://r"}
        st_r = MagicMock(status_code=200)
        st_r.json.return_value = {"status": "COMPLETED"}
        res_r = MagicMock(status_code=200)
        res_r.raise_for_status = MagicMock()
        res_r.json.return_value = {"image": {"url": "https://cdn/out.webp"}}
        img_r = MagicMock(status_code=200, content=webp_out)
        img_r.raise_for_status = MagicMock()
        mock_client.post = AsyncMock(return_value=post_r)
        mock_client.get = AsyncMock(side_effect=[st_r, res_r, img_r])
        mock_cm = AsyncMock()
        mock_cm.__aenter__.return_value = mock_client

        with patch("app.providers.fal_provider.httpx.AsyncClient", return_value=mock_cm):
            fal_res = await fal.synthesize(req)
        assert fal_res.provider_type == "FAL_CATVTON" and fal_res.external_job_id == "req-1"
        assert await fal.health_check() is True

        # 2) FashnVtonProvider
        fashn = FashnVtonProvider(api_key="fashn-key")
        f_client = AsyncMock()
        f_post = MagicMock(status_code=200)
        f_post.json.return_value = {"id": "pred-42"}
        f_st = MagicMock(status_code=200)
        f_st.json.return_value = {"status": "completed", "output": ["https://fashn/out.webp"]}
        f_img = MagicMock(status_code=200, content=webp_out)
        f_img.raise_for_status = MagicMock()
        f_client.post = AsyncMock(return_value=f_post)
        f_client.get = AsyncMock(side_effect=[f_st, f_img])
        f_cm = AsyncMock()
        f_cm.__aenter__.return_value = f_client

        with patch("app.providers.fashn_provider.httpx.AsyncClient", return_value=f_cm):
            fashn_res = await fashn.synthesize(req)
        assert fashn_res.provider_type == "FASHN_VTON" and fashn_res.external_job_id == "fashn_pred-42"

        # 3) LocalGpuVtonProvider (JSON base64 response)
        lgpu = LocalGpuVtonProvider(endpoint_url="http://127.0.0.1:8888/v1/tryon")
        g_client = AsyncMock()
        g_post = MagicMock(status_code=200, headers={"content-type": "application/json"})
        g_post.json.return_value = {
            "job_id": "lan-1",
            "image_base64": "data:image/webp;base64," + base64.b64encode(webp_out).decode("ascii"),
        }
        g_client.post = AsyncMock(return_value=g_post)
        g_cm = AsyncMock()
        g_cm.__aenter__.return_value = g_client

        with patch("app.providers.local_gpu_provider.httpx.AsyncClient", return_value=g_cm):
            lg_res = await lgpu.synthesize(req)
        assert lg_res.provider_type == "LOCAL_GPU_VTON" and lg_res.external_job_id == "lan-1"

        # 4) HuggingFaceZeroGpuVtonProvider (fallback to 2nd Space + temp dir cleanup)
        assert _extract_result_path({"path": "/tmp/a.png"}) == "/tmp/a.png"
        assert _extract_result_path(["", ("/tmp/b.png",)]) == "/tmp/b.png"
        assert _extract_result_path(None) is None

        hf_tmp = tmp_path / "hf_tmp"
        hf = HuggingFaceZeroGpuVtonProvider(enabled=True, tmp_dir=hf_tmp, timeout_seconds=15.0)
        large_webp = webp_out + b"\x00" * 3000

        call_count = {"n": 0}
        def _fake_space(**kwargs: Any) -> bytes:
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise RuntimeError("ZeroGPU quota exceeded")
            return large_webp

        with patch("app.providers.hf_gradio_provider._call_single_space_sync", side_effect=_fake_space):
            hf_res = await hf.synthesize(req)
        assert hf_res.provider_type == "HF_GRADIO_VTON"
        assert hf.circuit_breaker.is_open("hf:zhengchong/catvton") is True
        # Guarantee D: drive / tmp_dir cleaned up completely (no leaked portraits)
        assert list(hf_tmp.glob("hf_vton_*")) == []
