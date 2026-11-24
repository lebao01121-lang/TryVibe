"""MinIO / S3-compatible object storage adapter for private try-on artifacts."""

from app.storage.minio_client import MinioStorageClient

__all__ = ["MinioStorageClient"]
