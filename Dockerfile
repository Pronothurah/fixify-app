# Debian-based (not Alpine) — sqlite3's prebuilt native binary targets glibc,
# not Alpine's musl libc, so this avoids a from-source compile on install.
# Works as-is on both amd64 and arm64 (e.g. Oracle Cloud's Ampere A1).
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
