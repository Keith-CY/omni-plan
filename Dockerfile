FROM oven/bun:1.1.8 AS build

WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
RUN bun run build:server

FROM oven/bun:1.1.8

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=bun:bun /app/package.json /app/bun.lockb ./
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/server ./server
RUN mkdir -p /app/.data && chown -R bun:bun /app/.data

USER bun
EXPOSE 8787
VOLUME ["/app/.data"]
CMD ["bun", "server/index.ts"]
