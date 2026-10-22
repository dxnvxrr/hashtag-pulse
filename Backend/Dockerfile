# syntax=docker/dockerfile:1.7
# Build context is the repository root (see docker-compose.yml) so the web client in Web/ can be bundled.

# ---------- deps + build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY Backend/package.json Backend/package-lock.json ./
RUN npm ci

COPY Backend/prisma ./prisma
RUN npx prisma generate

COPY Backend/tsconfig.json ./
COPY Backend/src ./src
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --chown=node:node Backend/package.json ./
COPY --chown=node:node Web ./public
ENV WEB_ROOT=/app/public

USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# Apply pending migrations, then start. In multi-replica deployments run migrations as a separate job instead.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
