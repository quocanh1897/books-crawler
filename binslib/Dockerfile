FROM node:20-alpine AS base

FROM base AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the Next.js app (also runs build-time migration for schema)
RUN mkdir -p data && npx tsx scripts/migrate.ts && npm run build

# Bundle the migration script into a single JS file so it can run at
# container startup against the real (volume-mounted) database without
# needing tsx or the full node_modules.  better-sqlite3 is marked
# external because it's a native addon already in the standalone output.
RUN npx esbuild scripts/migrate.ts \
      --bundle \
      --platform=node \
      --format=cjs \
      --outfile=migrate.cjs \
      --external:better-sqlite3

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache python3 py3-pip make g++ \
    && pip3 install --break-system-packages ebooklib rich Pillow httpx

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Migration script + SQL migration files (needed by drizzle migrator)
COPY --from=builder /app/migrate.cjs ./migrate.cjs
COPY --from=builder /app/src/db/migrations ./src/db/migrations

EXPOSE 3000

# Run database migration at startup (rebuilds FTS index, applies schema
# changes) then start the Next.js server.  This ensures the volume-mounted
# production database is always up to date — the build-time migration only
# touches a throwaway DB that gets discarded.
CMD ["sh", "-c", "node migrate.cjs && node server.js"]
