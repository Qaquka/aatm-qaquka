FROM node:22-bookworm-slim
WORKDIR /app

# Optional tooling for NAS workflow
RUN apt-get update && apt-get install -y --no-install-recommends \
    mediainfo mktorrent ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
