FROM docker.io/library/node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM docker.io/library/node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    APP_DATA_DIR=/var/lib/torrentinel \
    POLL_INTERVAL_MINUTES=60

WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /data /var/lib/torrentinel \
  && chown node:node /data /var/lib/torrentinel
USER node

VOLUME ["/var/lib/torrentinel", "/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
