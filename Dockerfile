FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
# --ignore-scripts: better-sqlite3 and argon2 ship prebuilt binaries; without it npm tries to compile better-sqlite3,
# which fails on the slim image (no python or compiler).
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data GAMESERVERS_DIR=/srv/gameservers TEMPLATES_DIR=/app/templates
RUN apt-get update && apt-get install -y --no-install-recommends miniupnpc && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY templates ./templates
COPY package.json ./
# The release number this image reports in Settings (set by the publish workflow; empty falls back to package.json).
ARG APP_VERSION=""
ENV APP_VERSION=$APP_VERSION
CMD ["node", "dist/server/index.js"]
