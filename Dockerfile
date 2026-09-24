ARG BUN_VERSION
ARG NODE_VERSION
ARG DOCKER_VERSION
FROM docker:${DOCKER_VERSION}-cli AS docker
FROM oven/bun:${BUN_VERSION} AS bun
FROM node:${NODE_VERSION}-bookworm-slim

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ca-certificates curl unzip git gh fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

ARG OP_VERSION
COPY --from=quaz /scripts/qa/install-op.sh /tmp/install-op.sh
RUN sh /tmp/install-op.sh "${OP_VERSION}" && rm /tmp/install-op.sh

ARG CODEX_VERSION
ARG PLAYWRIGHT_MCP_VERSION
WORKDIR /tools
RUN bun add --exact @openai/codex@${CODEX_VERSION} @playwright/mcp@${PLAYWRIGHT_MCP_VERSION}
ENV PATH="/tools/node_modules/.bin:${PATH}" HOME=/tmp/home

WORKDIR /quaz
COPY --from=quaz /package.json /bun.lock /tsconfig.json ./
RUN bun install --frozen-lockfile
COPY --from=quaz /src ./src
COPY --from=quaz /scripts ./scripts

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun --no-env-file run build && mkdir -p /app/uploads
ARG QA_REVISION
LABEL app.qa.revision=${QA_REVISION}
ENV QUAZ_DB=/qa/state.db
ENTRYPOINT ["bun", "--no-env-file", "/quaz/scripts/qa/entry.ts"]
CMD ["controller"]
