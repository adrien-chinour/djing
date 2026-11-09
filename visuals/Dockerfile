# Remote visuals server (sessions only, no PipeWire): see README.md, section « Déploiement ».
# Alpine ships wget through busybox: Coolify's health check runs inside the container and needs curl or wget.
# node:24-alpine, digest read with `docker buildx imagetools inspect node:24-alpine` (v24.22.2, 2026-11-09).
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server.js ./
COPY public ./public

USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8765/healthz || exit 1
CMD ["node", "server.js", "--no-capture"]
