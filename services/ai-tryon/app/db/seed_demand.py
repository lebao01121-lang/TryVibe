from __future__ import annotations

import hashlib
import logging
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select

from app.db.database import TryOnDatabase
from app.db.models import TryOnDemandEvent, utcnow

logger = logging.getLogger("atelier.ai_tryon.seed")


def catalog_deterministic_uuid(seed_key: str) -> str:
    """Exact deterministic UUID formula matching catalog-seed.ts & inventory/seed.ts."""
    hex_str = hashlib.sha256(f"atelier-catalog-v3:{seed_key}".encode("utf-8")).hexdigest()
    return (
        f"{hex_str[0:8]}-{hex_str[8:12]}-4{hex_str[13:16]}"
        f"-8{hex_str[17:20]}-{hex_str[20:32]}"
    )


# Group A1 (Flagship Shirt 1, Size M) — High Try-On, Low Stock in inventory_db -> triggers PO Draft
GROUP_A_SLUG = "ao-blazer-linen-dang-suong"
GROUP_A_PRODUCT_ID = catalog_deterministic_uuid(f"product:{GROUP_A_SLUG}")
GROUP_A_M_SKU_ID = catalog_deterministic_uuid(f"sku:{GROUP_A_SLUG}:0:M")
GROUP_A_M_SKU_CODE = "AT-AOBLLI-C1-M"
GROUP_A_M_SIZE_CODE = "M"

# Group A2 (Flagship Shirt 2, Size M) — High Try-On, Low Stock in inventory_db -> > 40 combined Size M try-ons!
GROUP_A2_SLUG = "ao-polo-det-kim-bong-ai-cap"
GROUP_A2_PRODUCT_ID = catalog_deterministic_uuid(f"product:{GROUP_A2_SLUG}")
GROUP_A2_M_SKU_ID = catalog_deterministic_uuid(f"sku:{GROUP_A2_SLUG}:0:M")
GROUP_A2_M_SKU_CODE = "AT-AOPODE-C1-M"
GROUP_A2_M_SIZE_CODE = "M"

# Group A (Size XL) — High Try-On, Low Stock in inventory_db (available_qty = 2)
GROUP_A_SKU_ID = catalog_deterministic_uuid(f"sku:{GROUP_A_SLUG}:0:XL")
GROUP_A_SKU_CODE = "AT-AOBLLI-C1-XL"
GROUP_A_SIZE_CODE = "XL"

# Group B — High Try-On, Low Conversion (healthy stock -> UX/fit optimization insight)
GROUP_B_SLUG = "dam-du-tiec-lua-satin-co-do"
GROUP_B_PRODUCT_ID = catalog_deterministic_uuid(f"product:{GROUP_B_SLUG}")
GROUP_B_SKU_ID = catalog_deterministic_uuid(f"sku:{GROUP_B_SLUG}:0:M")
GROUP_B_SKU_CODE = "AT-DADUTI-C1-M"
GROUP_B_SIZE_CODE = "M"

SEEDED_DEMAND_TARGETS: dict[str, dict[str, Any]] = {
    "groupA1_M": {
        "slug": GROUP_A_SLUG,
        "productId": GROUP_A_PRODUCT_ID,
        "skuId": GROUP_A_M_SKU_ID,
        "skuCode": GROUP_A_M_SKU_CODE,
        "sizeCode": GROUP_A_M_SIZE_CODE,
        "tryOnCompleted": 26,
        "addToCartAfterTryon": 16,
    },
    "groupA2_M": {
        "slug": GROUP_A2_SLUG,
        "productId": GROUP_A2_PRODUCT_ID,
        "skuId": GROUP_A2_M_SKU_ID,
        "skuCode": GROUP_A2_M_SKU_CODE,
        "sizeCode": GROUP_A2_M_SIZE_CODE,
        "tryOnCompleted": 22,
        "addToCartAfterTryon": 12,
    },
    "groupA_XL": {
        "slug": GROUP_A_SLUG,
        "productId": GROUP_A_PRODUCT_ID,
        "skuId": GROUP_A_SKU_ID,
        "skuCode": GROUP_A_SKU_CODE,
        "sizeCode": GROUP_A_SIZE_CODE,
        "tryOnCompleted": 24,
        "addToCartAfterTryon": 14,
    },
    "groupB": {
        "slug": GROUP_B_SLUG,
        "productId": GROUP_B_PRODUCT_ID,
        "skuId": GROUP_B_SKU_ID,
        "skuCode": GROUP_B_SKU_CODE,
        "sizeCode": GROUP_B_SIZE_CODE,
        "tryOnCompleted": 28,
        "addToCartAfterTryon": 2,
    },
}


async def seed_baseline_demand_signals(db: TryOnDatabase) -> dict[str, Any]:
    """Idempotently seed >40 flagship Size M Try-On signals + Group A XL + Group B low-conversion."""
    specs: list[tuple[str, str, str, str, str, int, int, int]] = [
        # (prefix, product_id, sku_id, sku_code, size_code, tryon_n, atc_n, step_hours)
        (
            "seed-p5-grpam",
            GROUP_A_PRODUCT_ID,
            GROUP_A_M_SKU_ID,
            GROUP_A_M_SKU_CODE,
            GROUP_A_M_SIZE_CODE,
            26,
            16,
            4,
        ),
        (
            "seed-p6-grpa2m",
            GROUP_A2_PRODUCT_ID,
            GROUP_A2_M_SKU_ID,
            GROUP_A2_M_SKU_CODE,
            GROUP_A2_M_SIZE_CODE,
            22,
            12,
            4,
        ),
        (
            "seed-p5-grpa",
            GROUP_A_PRODUCT_ID,
            GROUP_A_SKU_ID,
            GROUP_A_SKU_CODE,
            GROUP_A_SIZE_CODE,
            24,
            14,
            4,
        ),
        (
            "seed-p5-grpb",
            GROUP_B_PRODUCT_ID,
            GROUP_B_SKU_ID,
            GROUP_B_SKU_CODE,
            GROUP_B_SIZE_CODE,
            28,
            2,
            3,
        ),
    ]

    now = utcnow()
    total_inserted = 0
    total_existing = 0

    async with db.session() as db_sess:
        for (
            prefix,
            product_id,
            sku_id,
            sku_code,
            size_code,
            tryon_n,
            atc_n,
            step_hours,
        ) in specs:
            sku_existing = int(
                (
                    await db_sess.execute(
                        select(func.count(TryOnDemandEvent.id)).where(
                            TryOnDemandEvent.sku_id == sku_id
                        )
                    )
                ).scalar_one()
            )
            total_existing += sku_existing
            if sku_existing >= 10:
                continue

            for idx in range(1, tryon_n + 1):
                ev_id = f"{prefix}-tryon-{idx:02d}"
                if await db_sess.get(TryOnDemandEvent, ev_id) is None:
                    db_sess.add(
                        TryOnDemandEvent(
                            id=ev_id,
                            product_id=product_id,
                            sku_id=sku_id,
                            sku_code=sku_code,
                            size_code=size_code,
                            session_id=f"{prefix}-sess-{idx:02d}",
                            user_id=f"seed-customer-{(idx % 15) + 1:02d}",
                            signal_type="TRYON_COMPLETED",
                            created_at=now - timedelta(hours=idx * step_hours),
                        )
                    )
                    total_inserted += 1

            for idx in range(1, atc_n + 1):
                ev_id = f"{prefix}-atc-{idx:02d}"
                if await db_sess.get(TryOnDemandEvent, ev_id) is None:
                    db_sess.add(
                        TryOnDemandEvent(
                            id=ev_id,
                            product_id=product_id,
                            sku_id=sku_id,
                            sku_code=sku_code,
                            size_code=size_code,
                            session_id=f"{prefix}-sess-{idx:02d}",
                            user_id=f"seed-customer-{(idx % 15) + 1:02d}",
                            signal_type="ADD_TO_CART_AFTER_TRYON",
                            created_at=now - timedelta(hours=max(1, idx * step_hours - 1)),
                        )
                    )
                    total_inserted += 1

        if total_inserted > 0:
            await db_sess.commit()

    if total_inserted > 0:
        logger.info(
            "Seeded %d tryon_demand_events (%s, %s, %s, %s)",
            total_inserted,
            GROUP_A_M_SKU_CODE,
            GROUP_A2_M_SKU_CODE,
            GROUP_A_SKU_CODE,
            GROUP_B_SKU_CODE,
        )

    return {
        "seeded": total_inserted > 0,
        "existingCount": total_existing,
        "inserted": total_inserted,
        "targets": SEEDED_DEMAND_TARGETS,
    }
