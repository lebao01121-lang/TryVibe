from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

logger = logging.getLogger("atelier.ai_tryon.storage")


class MinioStorageClient:
    """Async wrapper over boto3 S3v4 path-style client compatible with MinIO & local harness."""

    def __init__(
        self,
        *,
        endpoint_url: str,
        access_key: str,
        secret_key: str,
        region: str = "us-east-1",
        private_bucket: str = "atelier-private-tryon",
        garments_bucket: str = "atelier-garments",
        public_bucket: str = "atelier-public",
    ) -> None:
        self.endpoint_url = endpoint_url.rstrip("/")
        self.access_key = access_key
        self.secret_key = secret_key
        self.region = region
        self.private_bucket = private_bucket
        self.garments_bucket = garments_bucket
        self.public_bucket = public_bucket
        self._buckets_verified = False
        self._client: Any = boto3.client(
            "s3",
            endpoint_url=self.endpoint_url,
            aws_access_key_id=self.access_key,
            aws_secret_access_key=self.secret_key,
            region_name=self.region,
            config=BotoConfig(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                connect_timeout=3,
                read_timeout=10,
                retries={"max_attempts": 1},
            ),
        )

    def _ensure_buckets_sync(self) -> bool:
        if self._buckets_verified:
            return True
        try:
            for bucket in (
                self.private_bucket,
                self.garments_bucket,
                self.public_bucket,
            ):
                try:
                    self._client.head_bucket(Bucket=bucket)
                except ClientError as exc:
                    code = str(exc.response.get("Error", {}).get("Code", ""))
                    status_code = int(
                        exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
                    )
                    if status_code == 404 or code in ("404", "NoSuchBucket", "NotFound"):
                        try:
                            self._client.create_bucket(Bucket=bucket)
                        except ClientError:
                            pass
                    else:
                        raise
            self._buckets_verified = True
            return True
        except Exception as exc:
            logger.warning("MinIO bucket check skipped (%s)", exc.__class__.__name__)
            return False

    async def ensure_buckets(self) -> bool:
        return await asyncio.to_thread(self._ensure_buckets_sync)

    def _presign_put_sync(
        self,
        bucket: str,
        key: str,
        content_type: str,
        expires_in: int,
    ) -> str:
        return str(
            self._client.generate_presigned_url(
                ClientMethod="put_object",
                Params={
                    "Bucket": bucket,
                    "Key": key,
                    "ContentType": content_type,
                },
                ExpiresIn=expires_in,
            )
        )

    async def generate_presigned_put_url(
        self,
        *,
        key: str,
        content_type: str,
        bucket: str | None = None,
        expires_in: int = 180,
    ) -> str:
        target_bucket = bucket or self.private_bucket
        return await asyncio.to_thread(
            self._presign_put_sync,
            target_bucket,
            key,
            content_type,
            expires_in,
        )

    def _presign_get_sync(self, bucket: str, key: str, expires_in: int) -> str:
        return str(
            self._client.generate_presigned_url(
                ClientMethod="get_object",
                Params={
                    "Bucket": bucket,
                    "Key": key,
                },
                ExpiresIn=expires_in,
            )
        )

    async def generate_presigned_get_url(
        self,
        *,
        key: str,
        bucket: str | None = None,
        expires_in: int = 900,
    ) -> str:
        target_bucket = bucket or self.private_bucket
        return await asyncio.to_thread(
            self._presign_get_sync,
            target_bucket,
            key,
            expires_in,
        )

    def _head_object_sync(self, bucket: str, key: str) -> bool:
        try:
            self._client.head_object(Bucket=bucket, Key=key)
            return True
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            status_code = int(
                exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
            )
            if status_code == 404 or code in ("404", "NoSuchKey", "NotFound"):
                return False
            return False
        except Exception:
            return False

    async def head_object(self, *, key: str, bucket: str | None = None) -> bool:
        return await asyncio.to_thread(
            self._head_object_sync,
            bucket or self.private_bucket,
            key,
        )

    def _get_object_bytes_sync(self, bucket: str, key: str) -> bytes | None:
        try:
            resp = self._client.get_object(Bucket=bucket, Key=key)
            body = resp.get("Body")
            if body is None:
                return None
            return bytes(body.read())
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            status_code = int(
                exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
            )
            if status_code == 404 or code in ("404", "NoSuchKey", "NotFound"):
                return None
            raise

    async def get_object_bytes(self, *, key: str, bucket: str | None = None) -> bytes | None:
        return await asyncio.to_thread(
            self._get_object_bytes_sync,
            bucket or self.private_bucket,
            key,
        )

    def _put_object_bytes_sync(
        self,
        bucket: str,
        key: str,
        data: bytes,
        content_type: str,
    ) -> None:
        self._client.put_object(
            Bucket=bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
        )

    async def put_object_bytes(
        self,
        *,
        key: str,
        data: bytes,
        content_type: str = "image/webp",
        bucket: str | None = None,
    ) -> None:
        await asyncio.to_thread(
            self._put_object_bytes_sync,
            bucket or self.private_bucket,
            key,
            data,
            content_type,
        )

    def _delete_object_sync(self, bucket: str, key: str) -> bool:
        try:
            self._client.delete_object(Bucket=bucket, Key=key)
            return True
        except Exception as exc:
            logger.warning(
                "MinIO delete_object failed for %s/%s (%s)",
                bucket,
                key,
                exc.__class__.__name__,
            )
            return False

    async def delete_object(self, *, key: str, bucket: str | None = None) -> bool:
        return await asyncio.to_thread(
            self._delete_object_sync,
            bucket or self.private_bucket,
            key,
        )

    def _list_objects_sync(
        self,
        bucket: str,
        prefix: str = "",
    ) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        paginator = self._client.get_paginator("list_objects_v2")
        kwargs: dict[str, Any] = {"Bucket": bucket}
        if prefix:
            kwargs["Prefix"] = prefix
        for page in paginator.paginate(**kwargs):
            for obj in page.get("Contents", []):
                last_mod = obj.get("LastModified")
                results.append(
                    {
                        "key": str(obj.get("Key", "")),
                        "size": int(obj.get("Size", 0)),
                        "last_modified": last_mod if isinstance(last_mod, datetime) else None,
                    }
                )
        return results

    async def list_objects(
        self,
        *,
        bucket: str | None = None,
        prefix: str = "",
    ) -> list[dict[str, Any]]:
        return await asyncio.to_thread(
            self._list_objects_sync,
            bucket or self.private_bucket,
            prefix,
        )
