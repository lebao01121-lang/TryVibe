# syntax=docker/dockerfile:1.7
# =============================================================================
# Fashion Atelier AI Platform (v3.0) — Partner Portal (Next.js Standalone :3002)
# Build context: repository root (.)
# =============================================================================

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
ENV PNPM_HOME="/pnpm" \
    PNPM_STORE_DIR="/pnpm/store" \
    PATH="/pnpm:$PATH" \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS pruner
WORKDIR /app
RUN npm install -g turbo@2.5.4
COPY . .
RUN turbo prune @atelier/partner-portal --docker

FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY --from=pruner /app/out/full/ .
ARG NEXT_PUBLIC_BFF_URL=https://partner.localhost
ARG NEXT_PUBLIC_WS_URL=https://partner.localhost
ENV NEXT_PUBLIC_BFF_URL=${NEXT_PUBLIC_BFF_URL} \
    NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL} \
    NEXT_OUTPUT_STANDALONE=1 \
    NODE_ENV=production
RUN pnpm turbo run build --filter=@atelier/partner-portal...
RUN mkdir -p /app/apps/partner-portal/public

FROM node:20-alpine AS runner
RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME="0.0.0.0" \
    PORT=3002
RUN addgroup -g 1001 -S atelier && adduser -S -u 1001 -G atelier atelier
COPY --from=builder --chown=atelier:atelier /app/apps/partner-portal/.next/standalone ./
COPY --from=builder --chown=atelier:atelier /app/apps/partner-portal/.next/static ./apps/partner-portal/.next/static
COPY --from=builder --chown=atelier:atelier /app/apps/partner-portal/public ./apps/partner-portal/public
USER atelier
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3002/').then((r)=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/partner-portal/server.js"]
