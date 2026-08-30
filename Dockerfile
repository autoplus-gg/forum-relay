FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run prepare:config
RUN bun run build
RUN mkdir -p /app/.data

ENV NODE_ENV=production

CMD ["bun", "run", "start"]
