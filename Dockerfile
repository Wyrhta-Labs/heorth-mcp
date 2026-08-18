# heorth-mcp — the household's MCP server.
#
# No database, no migrations, no frontend: this repo is a REST client, so the
# image is just "compile TypeScript, then run dist/ with production deps".

# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Stage 2: Run
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Run unprivileged. The `node` user (uid 1000) ships with the base image; the
# process writes nothing to disk, so it needs no ownership of /app.
USER node

# Both upstreams are optional and none of the config is baked in — HEORTH_BASE_URL,
# KITH_BASE_URL, KITH_API_KEY, PORT and UPSTREAM_TIMEOUT_MS all come from the
# environment at run time (see .env.example).
EXPOSE 3200

# createApp() in src/app.ts serves /health next to /mcp. No curl or wget-with-TLS
# in the base image, so probe with node itself. Shell form so ${PORT} is resolved
# at run time and a compose-level port override is honoured.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3200)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
