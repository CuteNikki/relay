# The relay: Bun to run it, FFmpeg to move the stream
FROM oven/bun:1.4.0-alpine

# FFmpeg as a static build rather than Alpine's, which is 6.1: that reports
# no frame count for the stream it copies to YouTube, so there's no frame
# rate to show for it, where 8.1 does
COPY --from=mwader/static-ffmpeg:8.1.2 /ffmpeg /ffprobe /usr/local/bin/

WORKDIR /app

# Dependencies first, so a change to the code alone reuses them
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY index.ts ./
COPY src ./src

CMD ["bun", "run", "index.ts"]
