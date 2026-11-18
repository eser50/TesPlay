FROM node:24-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY *.js ./
COPY admin.html ./
COPY config.example.json ./config.json
COPY LICENSE THIRD-PARTY-NOTICES.md ./
COPY licenses ./licenses
COPY public ./public
COPY plugins ./plugins

# Mount external plugins at runtime and configure their paths explicitly.

RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/app/data
USER node

EXPOSE 3000

CMD ["node", "server.js"]
