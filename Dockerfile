FROM node:24-slim AS base

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
RUN npm ci && npm prune --omit=dev

# Runtime stage
FROM base AS runner

# Install dumb-init for proper PID 1 signal handling
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

# Copy production dependencies
COPY --from=deps /app/node_modules node_modules

# Copy built client assets
COPY --from=builder /app/dist/client dist/client

# Copy server source (runs via tsx at runtime)
COPY --from=builder /app/server server
COPY --from=builder /app/src/db src/db

# Copy migrations, agent assets, and config
COPY --from=builder /app/drizzle drizzle
COPY --from=builder /app/agent agent
COPY --from=builder /app/package.json package.json
COPY --from=builder /app/tsconfig.json tsconfig.json

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "tsx", "server/index.ts"]
