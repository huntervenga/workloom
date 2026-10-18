FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts && npm run build:libs && npm run build --workspace @workloom/api && npm run build --workspace @workloom/web
RUN npm prune --omit=dev --ignore-scripts

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/scripts/hosted-migrate.mjs ./scripts/hosted-migrate.mjs
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/main.js"]
