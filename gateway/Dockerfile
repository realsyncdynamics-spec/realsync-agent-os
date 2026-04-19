FROM node:20-alpine

LABEL maintainer="RealSyncDynamics <support@realsync.io>"
LABEL description="OpenClaw Gateway — Remote Execution Service"
LABEL version="1.0.0"

WORKDIR /app

# Install bash (needed to run .sh scripts) and curl (health-check probes)
RUN apk add --no-cache bash curl

# Copy dependency manifests first for layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm install --production && npm cache clean --force
# Copy application source
COPY src/ ./src/

# Create runtime directories and set permissions
RUN mkdir -p scripts logs && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=8443

EXPOSE 8443

# Health-check — probes the public /health endpoint every 30 s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

# Run as non-root user
USER node

CMD ["node", "src/server.js"]
