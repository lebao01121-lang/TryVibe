# syntax=docker/dockerfile:1.7
# =============================================================================
# Fashion Atelier AI Platform (v3.0) — Media Pipeline & Sharp Image Service (:4003)
# Uses node:20-slim + libvips42 for rock-solid native sharp binary processing
# Build context: repository root (.)
# =============================================================================

FROM node:20-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libvips-dev \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME="/pnpm" \
    PNPM_STORE_DIR="/pnpm/store" \
    PATH="/pnpm:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS pruner
WORKDIR /app
RUN npm install -g turbo@2.5.4
COPY . .
RUN turbo prune @atelier/media-pipeline --docker

FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@atelier/media-pipeline...
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter=@atelier/media-pipeline --prod deploy /prod --store-dir=/pnpm/store

FROM node:20-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libvips42 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4003 \
    MEDIA_SERVICE_PORT=4003
RUN groupadd -g 1001 -r atelier && useradd -r -u 1001 -g atelier -d /app -s /sbin/nologin atelier
COPY --from=builder --chown=atelier:atelier /prod ./
USER atelier
EXPOSE 4003
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4003/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
