# ============================================================
# RealSync Agent-OS — Backend Dockerfile (Multi-Stage)
# Stage 1: deps     — nur production dependencies
# Stage 2: runtime  — minimales Alpine-Image, non-root
# ============================================================

# ── Stage 1: Install production dependencies ─────────────────
FROM node:20-alpine AS deps

WORKDIR /build

# Install build tools needed for native modules (bcryptjs uses pure JS — no native needed,
# but pg has optional native binding)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production --ignore-scripts && \
    # Remove optional native pg binding (pure JS fallback is fine for Cloud Run)
    rm -rf node_modules/pg-native || true

# ── Stage 2: Runtime image ────────────────────────────────────
FROM node:20-alpine AS runtime

# Security: add dumb-init for proper PID 1 handling (signal forwarding)
RUN apk add --no-cache dumb-init

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S realsync && \
    adduser  -u 1001 -S realsync -G realsync

# Copy dependencies from stage 1
COPY --from=deps --chown=realsync:realsync /build/node_modules ./node_modules

# Copy application source
COPY --chown=realsync:realsync src/        ./src/
COPY --chown=realsync:realsync package.json ./

# Cloud Run requires PORT 8080
ENV NODE_ENV=production \
    PORT=8080 \
    # Disable color in logs (structured JSON)
    NO_COLOR=1 \
    # Node.js production hardening
    NODE_OPTIONS="--max-old-space-size=400"

EXPOSE 8080

# Switch to non-root user
USER realsync

# dumb-init ensures SIGTERM is forwarded correctly to Node.js
# This enables graceful shutdown in Cloud Run
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/app.js"]

# ── Health check (used by docker-compose, not Cloud Run) ─────
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1
