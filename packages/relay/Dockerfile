# Agent Room relay. Build from the repository root:
#   docker build -f packages/relay/Dockerfile -t agent-room-relay .
# Runs anywhere a container runs; TLS is expected to be terminated in front of it (see README).
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
# The relay's tsconfig extends the repo-level base, so keep the same relative layout.
COPY tsconfig.base.json ./
WORKDIR /app/packages/relay
COPY packages/relay/package.json ./
# Spike: not lockfile-pinned inside the image (the workspace lockfile covers the monorepo). Pin before production use.
RUN npm install --include=dev --no-audit --no-fund --loglevel=error
COPY packages/relay/tsconfig.json ./
COPY packages/relay/src ./src
USER node
EXPOSE 8080
ENV PORT=8080
# RELAY_HUBS="hubId:sha256hex[,hubId2:sha256hex]" must be supplied at run time.
CMD ["npx", "tsx", "src/main.ts"]
