# syntax=docker/dockerfile:1.7
# =============================================================================
# Fashion Atelier AI Platform (v3.0) — Anti-Oversell Inventory & Procurement (:4004)
# Build context: repository root (.)
# =============================================================================

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
ENV PNPM_HOME="/pnpm" \
    PNPM_STORE_DIR="/pnpm/store" \
    PATH="/pnpm:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS pruner
WORKDIR /app
RUN npm install -g turbo@2.5.4
COPY . .
RUN turbo prune @atelier/inventory --docker

FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@atelier/inventory...
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter=@atelier/inventory --prod deploy /prod --store-dir=/pnpm/store

FROM node:20-alpine AS runner
RUN apk add --no-cache libc6-compat ca-certificates
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4004 \
    INVENTORY_SERVICE_PORT=4004
RUN addgroup -g 1001 -S atelier && adduser -S -u 1001 -G atelier atelier
COPY --from=builder --chown=atelier:atelier /prod ./
USER atelier
EXPOSE 4004
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4004/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
