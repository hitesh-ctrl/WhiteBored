# Targets: web (Next.js), socket (Socket.IO server), migrate (one-off schema migration), and app,
# the last stage and so the default: everything in ONE container behind one address and port
# (for hosts such as Render that give a service a single web address).
#   docker build --target web --build-arg NEXT_PUBLIC_SOCKET_URL=https://socket.example.com -t whiteboard-web .
#   docker build --target socket -t whiteboard-socket .
#   docker build --target migrate -t whiteboard-migrate .
FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM deps AS build
COPY . .
# Baked into the browser bundle at build time. The web image keeps it in its environment, so
# the page security policy (computed when the server starts) uses the same value.
ARG NEXT_PUBLIC_SOCKET_URL=http://localhost:4000
ENV NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL
RUN npx prisma generate && npx next build

FROM build AS migrate
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

FROM build AS web
ENV NODE_ENV=production
RUN chown -R node:node /app/.next
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["npx", "next", "start", "-p", "3000"]

FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM base AS socket
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json tsconfig.json prisma.config.ts ./
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY src/lib ./src/lib
COPY --from=build /app/src/generated ./src/generated
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/health || exit 1
# node runs directly (not through npx) so SIGTERM reaches the server and it can shut down gracefully
CMD ["node", "--import", "tsx", "src/server/index.ts"]

# The whole app in one container: pages, socket server and router on $PORT. The sockets use the page's
# own address, so nothing needs to know the public address at build time.
FROM deps AS build-app
COPY . .
ENV NEXT_PUBLIC_SOCKET_URL=
RUN npx prisma generate && npx next build

FROM build-app AS app
ENV NODE_ENV=production PORT=10000 RUN_MIGRATIONS=true
RUN chown -R node:node /app/.next
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1
CMD ["node", "scripts/serve.mjs"]
