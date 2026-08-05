# syntax=docker/dockerfile:1

# Build stage: compile TypeScript to dist/ from the bun lockfile.
# bun.lock pins tree-sitter-kotlin (a transitive devDep via @workos/openapi-spec
# -> @workos/oagen) to a git+ssh URL that can't clone inside the image without
# SSH credentials. Rewrite that one entry to the `github:` shorthand so bun
# downloads a tarball over HTTPS at the same pinned commit, and blank its
# integrity hash (the hash was computed from a git clone, not a tarball). Every
# other dependency — including typescript@5.9.3 — stays at its locked version,
# keeping the build reproducible.
FROM oven/bun:1.3.14 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN sed -i \
      -e 's|git+ssh://git@github.com/fwcd/tree-sitter-kotlin.git#|github:fwcd/tree-sitter-kotlin#|g' \
      -e 's/"sha512-onbog[^"]*"/""/g' \
      bun.lock \
 && bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN bun run build

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
