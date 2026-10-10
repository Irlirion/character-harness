FROM node:25-bookworm-slim AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY migrations ./migrations
COPY scripts ./scripts
COPY tests ./tests
COPY characters ./characters
RUN pnpm typecheck && pnpm test

FROM dependencies AS runtime
ENV NODE_ENV=production
RUN mkdir -p /data/workspace /data/pi && chown -R node:node /data
USER node
CMD ["node", "--experimental-strip-types", "apps/core/main.ts"]
