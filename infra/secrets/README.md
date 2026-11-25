# Production Docker Secrets Provisioning (`infra/secrets/`)

`infra/docker-compose.prod.yml` intentionally contains **ZERO hardcoded default passwords**.
All production credentials are supplied via Docker `secrets:` mounted read-only under `/run/secrets/*` plus required environment variables in `.env.prod`.

> **SECURITY WARNING**: Never commit real secret files into Git! Only `.gitkeep` and this `README.md` are tracked; all other files in `infra/secrets/` are excluded from Docker build contexts via `.dockerignore`.

## Required Secret Files

Provision the following 7 files inside `infra/secrets/` (or point `ATELIER_SECRETS_DIR` to an encrypted host directory with `chmod 600` permissions):

| Secret Name | File Path | Purpose |
| --- | --- | --- |
| `postgres_password` | `infra/secrets/postgres_password.txt` | PostgreSQL 16 superuser password (`POSTGRES_PASSWORD_FILE`) |
| `redis_password` | `infra/secrets/redis_password.txt` | Redis 7 `requirepass` & Socket.io Redis Adapter auth |
| `rabbitmq_password` | `infra/secrets/rabbitmq_password.txt` | RabbitMQ AMQP broker password (`atelier_mq`) |
| `minio_secret_key` | `infra/secrets/minio_secret_key.txt` | MinIO S3 root password / secret key (`MINIO_ROOT_PASSWORD_FILE`) |
| `internal_service_secret` | `infra/secrets/internal_service_secret.txt` | Shared HMAC/internal header secret (`x-internal-secret`) across BFF & microservices |
| `meilisearch_master_key` | `infra/secrets/meilisearch_master_key.txt` | Meilisearch v1.11 master key (`MEILI_MASTER_KEY`, >= 16 bytes) |
| `jwt_private_key` | `infra/secrets/jwt_private_key.pem` | RS256/ES256 private signing key (PEM) for Auth & BFF JWT issuance |

## Quick Provisioning Example (Staging / Production Host)

```bash
umask 077
mkdir -p infra/secrets

openssl rand -base64 32 | tr -d '\n' > infra/secrets/postgres_password.txt
openssl rand -base64 32 | tr -d '\n' > infra/secrets/redis_password.txt
openssl rand -base64 32 | tr -d '\n' > infra/secrets/rabbitmq_password.txt
openssl rand -base64 32 | tr -d '\n' > infra/secrets/minio_secret_key.txt
openssl rand -base64 48 | tr -d '\n' > infra/secrets/internal_service_secret.txt
openssl rand -hex 32    | tr -d '\n' > infra/secrets/meilisearch_master_key.txt
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out infra/secrets/jwt_private_key.pem

chmod 600 infra/secrets/*.txt infra/secrets/*.pem
```

## Launching the Production Stack

```bash
# Core production stack (15 app containers + 7 infra containers + NGINX TLS)
docker compose --env-file .env.prod -f infra/docker-compose.prod.yml up -d --build

# Production stack + Centralized Observability (OTel Collector, Tempo, Prometheus, Grafana)
docker compose --env-file .env.prod -f infra/docker-compose.prod.yml --profile observability up -d
```
