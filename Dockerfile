# API + relay server only. Veil has no browser version, so no web client is
# built or served. SQLite lives on the volume mounted at /data.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/chat.db PORT=8787
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY server server
COPY shared shared
EXPOSE 8787
# Fly volumes mount root-owned: hand /data to the node user, then drop root.
CMD ["sh", "-c", "mkdir -p /data && chown node:node /data && exec su node -s /bin/sh -c 'node --import tsx server/src/index.ts'"]
