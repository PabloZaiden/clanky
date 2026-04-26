# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy repository
COPY . .

# Install dependencies
RUN bun install --frozen-lockfile

# Build the standalone server binary
RUN cd apps/server && bun run build

# Production stage - minimal image
FROM debian:bookworm-slim

WORKDIR /app

# Install required packages:
# - ca-certificates: for HTTPS requests
# - curl: for HEALTHCHECK
# - tini: init process for proper signal handling (Ctrl+C works)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tini \
    openssh-client \
    sshpass \
  && rm -rf /var/lib/apt/lists/*

# Copy the standalone server binary from builder
COPY --from=builder /app/apps/server/dist/ralpher /app/ralpher

# Create a non-root user for running the application
RUN groupadd --system ralpher && \
    useradd --system --gid ralpher --no-create-home ralpher

# Create data directory and set ownership
RUN mkdir -p /app/data && chown -R ralpher:ralpher /app/data

# Set environment variables
ENV NODE_ENV=production
# Optional runtime controls:
# - RALPHER_HOST limits which interfaces Bun listens on (default: 127.0.0.1; set to 0.0.0.0 for all interfaces)
ENV RALPHER_PORT=8080
# Override the default 127.0.0.1 so the container is reachable from outside
ENV RALPHER_HOST=0.0.0.0
ENV RALPHER_DATA_DIR=/app/data
ENV TERM=xterm-256color

# Expose port 8080 (non-root user cannot bind to privileged ports)
EXPOSE 8080

# Run as non-root user
USER ralpher

# Health check using the /api/health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${RALPHER_PORT}/api/health || exit 1

# Use tini as init process for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--"]

# Run the server
CMD ["/app/ralpher"]
