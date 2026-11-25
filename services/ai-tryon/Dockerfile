# syntax=docker/dockerfile:1.7
# =============================================================================
# Fashion Atelier AI Platform (v3.0) — AI Virtual Try-On FastAPI + Worker (:4009)
# Build context: repository root (.)
# Supports TRYON_ROLE=api | worker | all via /usr/local/bin/docker-entrypoint.sh
# =============================================================================

FROM python:3.12-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY services/ai-tryon/pyproject.toml services/ai-tryon/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY services/ai-tryon/app ./app
COPY services/ai-tryon/alembic ./alembic
COPY services/ai-tryon/alembic.ini ./alembic.ini
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM python:3.12-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libgl1 \
      libglib2.0-0 \
      libgomp1 \
      libjpeg62-turbo \
      libsm6 \
      libwebp7 \
      libxext6 \
      libxrender1 \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1001 -r atelier && useradd -r -u 1001 -g atelier -d /app -s /sbin/nologin atelier \
    && mkdir -p /app/.project-data/tmp /app/.project-data/ai-models \
    && chown -R atelier:atelier /app

COPY --from=builder --chown=atelier:atelier /app /app
COPY --chown=atelier:atelier services/ai-tryon/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AI_TRYON_HOST="0.0.0.0" \
    AI_TRYON_PORT="4009" \
    TRYON_ROLE="all" \
    TRYON_TMP_DIR="/app/.project-data/tmp" \
    TRYON_MODELS_DIR="/app/.project-data/ai-models"

USER atelier
EXPOSE 4009

HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=3 \
  CMD python -c "import os, time, urllib.request, sys; role=os.environ.get('TRYON_ROLE','all').lower(); hb='/tmp/tryon-worker.alive'; sys.exit(0 if (os.path.exists(hb) and time.time()-os.path.getmtime(hb)<60) else 1) if role=='worker' else urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('AI_TRYON_PORT','4009')}/health\", timeout=4)"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
