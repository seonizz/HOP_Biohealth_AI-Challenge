FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS frontend
WORKDIR /app
COPY scripts/build.mjs scripts/build.mjs
COPY frontend frontend
RUN node scripts/build.mjs
FROM caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
COPY --from=frontend /app/frontend/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
