# Targets: web (Next.js), socket (Socket.IO server), migrate (one-off schema migration).
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
# The browser reads this at build time, and the page security policy reads it at start.
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
CMD ["npx", "next", "start", "-p", "3000"]

FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM base AS socket
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json tsconfig.json prisma.config.ts ./
COPY src ./src
COPY --from=build /app/src/generated ./src/generated
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["npx", "tsx", "src/server/index.ts"]
