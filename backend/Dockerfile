FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json openapi.json openapi-v2.json ./
COPY --chown=node:node docs/MALSSI_QUESTIONNAIRE_V1.json ./docs/MALSSI_QUESTIONNAIRE_V1.json
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node public ./public
COPY --chown=node:node data/original-frontend.json data/original-model-utils.js data/original-mock-model.js ./data/
COPY --chown=node:node scripts/migrate.ts scripts/grant-runtime.ts scripts/malssi-worker.ts scripts/malssi-retention.ts scripts/malssi-deletion-ledger.ts ./scripts/
USER node
STOPSIGNAL SIGTERM
CMD ["node", "src/server.ts"]
