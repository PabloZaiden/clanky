# Build stage
FROM oven/bun:1 AS builder

WORKDIR /clanky
ARG TARGETARCH

COPY . .

# Install dependencies
RUN bun install --frozen-lockfile

# Build the standalone product binary
RUN case "$TARGETARCH" in \
      amd64) BUN_TARGET=bun-linux-x64 ;; \
      arm64) BUN_TARGET=bun-linux-arm64 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    bun src/build.ts --target="$BUN_TARGET" && \
    cp "dist/clanky-${BUN_TARGET#bun-}" /tmp/clanky

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

# Copy the standalone product binary from builder
COPY --from=builder /tmp/clanky /app/clanky

# Create a non-root user for running the application
RUN groupadd --system clanky && \
    useradd --system --gid clanky --no-create-home clanky

# Create data directory and set ownership
RUN mkdir -p /app/data && chown -R clanky:clanky /app/data

# Set environment variables
ENV NODE_ENV=production
# Optional runtime controls:
# - CLANKY_HOST limits which interfaces Bun listens on (default: 127.0.0.1; set to 0.0.0.0 for all interfaces)
ENV CLANKY_PORT=8080
# Override the default 127.0.0.1 so the container is reachable from outside
ENV CLANKY_HOST=0.0.0.0
ENV CLANKY_DATA_DIR=/app/data
ENV TERM=xterm-256color

# Expose port 8080 (non-root user cannot bind to privileged ports)
EXPOSE 8080

# Run as non-root user
USER clanky

# Health check using the /api/health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${CLANKY_PORT}/api/health || exit 1

# Use tini as init process for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--"]

# Run the server subcommand
CMD ["/app/clanky", "serve"]
