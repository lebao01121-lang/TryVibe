"""RabbitMQ asynchronous try-on worker skeleton."""

from app.workers.consumer import (
    RETRY_TIERS_MS,
    TRYON_DLQ,
    TRYON_DLX,
    TRYON_EXCHANGE,
    TRYON_PREFETCH_COUNT,
    TRYON_QUEUE,
    TRYON_ROUTING_KEY,
    TryOnWorkerConsumer,
)

__all__ = [
    "RETRY_TIERS_MS",
    "TRYON_DLQ",
    "TRYON_DLX",
    "TRYON_EXCHANGE",
    "TRYON_PREFETCH_COUNT",
    "TRYON_QUEUE",
    "TRYON_ROUTING_KEY",
    "TryOnWorkerConsumer",
]
