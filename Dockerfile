# syntax=docker/dockerfile:1

# ---- Stage 1: build the React/Vite client -----------------------------
FROM node:20-bookworm-slim AS client-builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm ci
COPY client client
RUN npm run build -w client


# ---- Stage 2: install only the server's production dependencies -------
FROM node:20-bookworm-slim AS server-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
# Sharp needs a native libvips binary at install time; the official
# node:*-bookworm (glibc, not alpine/musl) image is what Sharp publishes
# prebuilt binaries for, so this stays a plain `npm ci` with no extra
# system packages to install.
RUN npm ci --omit=dev --workspace=server


# ---- Stage 3: runtime ---------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run as an unprivileged user rather than root.
RUN groupadd -r compressor && useradd -r -g compressor compressor

COPY --from=server-deps /app/node_modules ./node_modules
COPY server server
COPY --from=client-builder /app/client/dist ./client/dist

RUN mkdir -p /app/server/uploads /app/server/data \
    && chown -R compressor:compressor /app

USER compressor

# Uploaded/compressed files and history should survive container restarts -
# mount a volume here in production (see docker-compose.yml).
VOLUME ["/app/server/uploads", "/app/server/data"]

EXPOSE 5555
ENV PORT=5555 HOST=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5555)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
