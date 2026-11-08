# One image for every role (web, worker, migrate, CLI), as the tech-stack decision requires.
# Node 24 runs the TypeScript sources directly, so only the dashboard needs a build.
# Pinned by digest (supply-chain safety). Dependabot keeps it updated.
FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
RUN npm install -g pnpm@12.16.1
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @helpos/web build \
  && pnpm install --frozen-lockfile --prod

FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data/files && chown node:node /data/files
USER node
WORKDIR /app/apps/server
ENV HELPOS_WEB_DIR=/app/apps/web/dist \
  HELPOS_FILES_DIR=/data/files
EXPOSE 3000
CMD ["node", "src/main.ts"]
