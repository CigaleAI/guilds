# CORE is where this repository sits in the build context and under /app. A repository that
# extends core builds this file from its own root with core in a subdirectory; the manifests and
# lockfile at the context's root are then that repository's workspace.
ARG CORE=.

# Node 24.21.0 bookworm-slim. Exact patch and multi-arch index digest;
# upgrade this pin deliberately.
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS base
ARG CORE

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/usr/local/share/pnpm \
    PATH="/usr/local/share/pnpm:/app/${CORE}/apps/orchestrator/node_modules/.bin:${PATH}"

RUN corepack enable \
    && corepack prepare pnpm@10.17.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ${CORE}/tsconfig.base.json ${CORE}/

# The React app (apps/web), built to static files the orchestrator serves at the site root.
FROM base AS web
ARG CORE
COPY ${CORE}/apps/web/package.json ${CORE}/apps/web/
COPY ${CORE}/packages/ui/package.json ${CORE}/packages/ui/
# `...` installs @guildsrun/ui as well, so theme.css can resolve its fonts.
RUN pnpm install --frozen-lockfile --filter "@guildsrun/web..."
COPY ${CORE}/packages/ui ${CORE}/packages/ui
COPY ${CORE}/apps/web ${CORE}/apps/web
RUN pnpm --filter @guildsrun/web build \
    && pnpm --filter @guildsrun/ui build-storybook \
    && cp -R ${CORE}/packages/ui/storybook-static ${CORE}/apps/web/dist/storybook

FROM base
ARG CORE
COPY ${CORE}/apps/orchestrator/package.json ${CORE}/apps/orchestrator/tsconfig.json ${CORE}/apps/orchestrator/

# tsx stays a devDependency; install the lockfile as-is so `pnpm start` works.
# NODE_ENV=production is set after install so pnpm does not drop tsx.
RUN pnpm install --frozen-lockfile

COPY ${CORE}/apps/orchestrator/src ${CORE}/apps/orchestrator/src
COPY ${CORE}/apps/orchestrator/scripts ${CORE}/apps/orchestrator/scripts
COPY ${CORE}/apps/orchestrator/drizzle ${CORE}/apps/orchestrator/drizzle
COPY ${CORE}/apps/orchestrator/drizzle.config.ts ${CORE}/apps/orchestrator/drizzle.config.ts
COPY --from=web /app/${CORE}/apps/web/dist ${CORE}/apps/web/dist

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app/${CORE}/apps/orchestrator
EXPOSE 8080

# node is PID 1 so Docker SIGTERM reaches the Fastify process (SHUTDOWN_TIMEOUT 15s).
# --import instrument.ts before server.ts so Sentry hooks pg/http/fastify.
# Hosted/GCP compose must not bind-mount src over this image.
CMD ["node", "--import", "tsx", "--import", "./src/instrument.ts", "src/server.ts"]
