ARG QUAZ_BASE=quaz:base
FROM ${QUAZ_BASE}
ARG QUAZ_BASE

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun --no-env-file run build && mkdir -p /app/uploads
ARG QA_REVISION
LABEL app.qa.revision=${QA_REVISION} app.qa.base=${QUAZ_BASE}
ENV QUAZ_DB=/qa/state.db
