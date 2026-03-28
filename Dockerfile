FROM node:22-slim AS base

# Build stage
FROM base AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production dependencies only
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime stage
FROM base AS runner

# Install dumb-init for proper PID 1 signal handling
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --gid 1001 appuser \
    && useradd --uid 1001 --gid 1001 --shell /bin/false --create-home appuser

WORKDIR /app

ENV NODE_ENV=production

# Copy built output and production dependencies
COPY --from=builder --chown=appuser:appuser /app/.output .output
COPY --from=builder --chown=appuser:appuser /app/package.json package.json
COPY --from=builder --chown=appuser:appuser /app/drizzle drizzle
COPY --from=builder --chown=appuser:appuser /app/drizzle.config.ts drizzle.config.ts
COPY --from=builder --chown=appuser:appuser /app/src/db src/db
COPY --from=deps --chown=appuser:appuser /app/node_modules node_modules

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", ".output/server/index.mjs"]
