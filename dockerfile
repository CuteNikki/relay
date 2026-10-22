# Use official lightweight Bun image
FROM oven/bun:alpine

# Install ffmpeg
RUN apk add --no-cache ffmpeg

# Set working directory
WORKDIR /app

# Copy application files
COPY package.json bun.lockb* ./
# Run install if you have external package dependencies (ignore if no external packages)
RUN bun install --production

COPY index.ts ./


# Run the Bun application
CMD ["bun", "run", "index.ts"]