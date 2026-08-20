# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- builder ----
# better-sqlite3 is a native addon. It usually resolves a prebuilt binary, but
# when it doesn't it needs a full toolchain — kept in a throwaway stage so gcc
# and python never ship in the runtime image.
FROM node:22-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests only, so this layer caches until dependencies actually change.
COPY package.json package-lock.json ./

# `npm ci` (not `install`) so the lockfile is authoritative — a sniper that
# silently drifted to a new ethers minor is not something to discover at T=0.
RUN npm ci --omit=dev

# ---------------------------------------------------------------- runtime ----
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bot.js ./
COPY config ./config
COPY src ./src

# The SQLite DB holds ENCRYPTED USER PRIVATE KEYS. This must be a mounted
# volume: if the container's writable layer is discarded, every user wallet is
# gone and any funds in them are unrecoverable.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

# Never run as root — this process handles other people's key material.
USER node

# No EXPOSE / no ports. Telegram long-polling is outbound-only, so this needs
# no inbound networking. Deploy it as a *worker*, not a web service (DEPLOY.md).
#
# Exec form keeps node as PID 1 so it receives SIGTERM directly; bot.js installs
# SIGINT/SIGTERM handlers that stop the scheduler and close the DB cleanly.
CMD ["node", "bot.js"]
