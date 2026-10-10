# syntax=docker/dockerfile:1

# ---- build: install everything, compile all workspaces ----------------------
FROM node:22-bookworm-slim AS build
# mediasoup downloads a prebuilt worker binary when one matches the platform
# and falls back to compiling it; the toolchain covers the fallback.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY protocol/package.json protocol/
COPY client/package.json client/
COPY server/package.json server/
COPY demo/package.json demo/
COPY bench/package.json bench/
RUN npm ci
COPY tsconfig.base.json ./
COPY protocol protocol
COPY client client
COPY server server
COPY demo demo
RUN npm run build
RUN npm prune --omit=dev

# ---- server: the voice server only ------------------------------------------
FROM node:22-bookworm-slim AS server
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/protocol/package.json protocol/
COPY --from=build /app/protocol/dist protocol/dist
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
USER node
EXPOSE 7800
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7800)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]

# ---- demo: development page + ticket minting (never deploy this) ------------
FROM node:22-bookworm-slim AS demo
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/demo/package.json demo/
COPY --from=build /app/demo/dev-server.mjs /app/demo/lan.mjs demo/
COPY --from=build /app/demo/public demo/public
COPY --from=build /app/demo/dist demo/dist
USER node
EXPOSE 5173
CMD ["node", "demo/dev-server.mjs"]
