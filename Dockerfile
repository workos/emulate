# syntax=docker/dockerfile:1

# Build stage: compile TypeScript to dist/.
# Uses node:22-slim instead of oven/bun because the bun.lock contains a
# transitive devDependency (tree-sitter-kotlin) pinned to a git+ssh URL that
# cannot be cloned without SSH credentials. npm resolves the same github:
# URL over HTTPS. The build output (tsc) is identical regardless of the
# package manager that installed typescript.
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Deps stage: install production dependencies from the frozen bun lockfile.
# This stage only needs production deps (no git+ssh transitive devDeps), so
# the bun lockfile works correctly.
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# Runtime stage: minimal Node image with only what the emulator needs.
FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/workos/emulate"
LABEL org.opencontainers.image.title="WorkOS Emulate"
LABEL org.opencontainers.image.description="Local WorkOS API emulator for tests and development"
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 --ingroup nodejs emulate
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
USER emulate
EXPOSE 4100
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--host", "0.0.0.0"]
