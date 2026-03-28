FROM node:22-slim AS base

# Build stage
FROM base AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Runtime stage
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy built output
COPY --from=builder /app/.output .output
COPY --from=builder /app/package.json package.json
COPY --from=builder /app/drizzle drizzle
COPY --from=builder /app/drizzle.config.ts drizzle.config.ts
COPY --from=builder /app/src/db src/db
COPY --from=builder /app/node_modules node_modules

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
