# syntax=docker/dockerfile:1

# 1. Build the SPA — rust-embed bakes web/dist into the binary.
FROM node:22-alpine AS web
WORKDIR /web
RUN npm i -g pnpm
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# 2. Build the static binary (rust:alpine targets musl by default → fully static).
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev gcc make
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY --from=web /web/dist ./web/dist
RUN cargo build --release

# 3. Minimal runtime — just the static binary.
FROM scratch
COPY --from=build /src/target/release/yagura /yagura
ENV YAGURA_BIND=0.0.0.0:8080 \
    YAGURA_DB=/data/yagura.db
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/yagura"]
