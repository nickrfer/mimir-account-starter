FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
WORKDIR /app
RUN npm install --global pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/verifier/package.json packages/verifier/package.json
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages/verifier packages/verifier
RUN pnpm build

FROM build AS admin
COPY database database
COPY fixtures fixtures
COPY packages/contracts packages/contracts
COPY tools/admin tools/admin
COPY tools/checks tools/checks
COPY tests tests
RUN mkdir /probe-state && chown node:node /probe-state
USER node
ENTRYPOINT ["node", "tools/admin/cli.mjs"]

FROM build AS development
WORKDIR /app/apps/web
USER node
ENV MIMIR_WATCH_POLLING=true
ENV VITE_CACHE_DIR=/tmp/mimir-vite
EXPOSE 5173
CMD ["node", "node_modules/vite/bin/vite.js", "--configLoader", "native"]

FROM build AS verifier
USER node
ENTRYPOINT ["node", "packages/verifier/dist/index.js"]

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY --from=build /app/apps/web/dist /app/apps/web/dist
COPY package.json ./
COPY apps/api/package.json apps/api/package.json
COPY tools/runtime/audit.mjs tools/runtime/audit.mjs
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
