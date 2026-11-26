# syntax=docker/dockerfile:1

# Dependabot (#25) updates the image tags. Keep the two node tags the same.

FROM litestream/litestream:0.5.18 AS litestream

FROM node:24-trixie-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Tools to compile better-sqlite3 if its prebuilt binary is not available.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Makes .next/standalone with the static files and the migrations.
RUN npm run build

FROM node:24-trixie-slim
WORKDIR /app
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3000 \
  HOSTNAME=0.0.0.0 \
  DATABASE_PATH=/data/shopping-lists.db
# Litestream needs the CA certificates for R2.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY litestream.yml /etc/litestream.yml
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=build --chown=node:node /app/.next/standalone ./
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
