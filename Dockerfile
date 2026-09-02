# syntax=docker/dockerfile:1

# Debian slim rather than Alpine: the local embedding provider (slice 3) pulls in
# onnxruntime-node, which ships glibc binaries and does not run on musl.
ARG NODE_IMAGE=node:22-bookworm-slim

# --- deps ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- builder ------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# No build-time configuration is set here on purpose: nothing fake, and no
# secret-shaped value, ever enters an image layer. src/server/env.ts skips
# validation during the build phase and the server validates for real at startup.
ENV NEXT_TELEMETRY_DISABLED=1

# Bake the embedding model into the image. The runtime has remote model loading
# disabled, so this is the only chance to fetch it — and it means the container
# needs no network at all.
RUN node scripts/fetch-model.mjs

RUN npm run build

# --- runner -------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as the unprivileged user the base image already provides.
USER node

# `output: "standalone"` emits a server bundle with only the modules it traced.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Read from disk at runtime and not traced by the bundler, so each must be
# copied explicitly. Paths match src/server/db/migrate.ts and src/server/rag/.
COPY --from=builder --chown=node:node /app/src/server/db/migrations ./src/server/db/migrations
COPY --from=builder --chown=node:node /app/.models ./.models
COPY --from=builder --chown=node:node /app/seed ./seed
COPY --from=builder --chown=node:node /app/prompts ./prompts

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
