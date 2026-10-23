# Server + web client in one image. The server serves the built client from
# client/dist and stores its SQLite database on the volume mounted at /data.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build --workspace client

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/chat.db PORT=8787
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY server server
COPY shared shared
COPY --from=build /app/client/dist client/dist
EXPOSE 8787
# Fly volumes mount root-owned: hand /data to the node user, then drop root.
CMD ["sh", "-c", "mkdir -p /data && chown node:node /data && exec su node -s /bin/sh -c 'node --import tsx server/src/index.ts'"]
