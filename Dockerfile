# The relay: Bun to run it, FFmpeg to move the stream
FROM oven/bun:1.4.0-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

# Dependencies first, so a change to the code alone reuses them
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY index.ts ./

CMD ["bun", "run", "index.ts"]
