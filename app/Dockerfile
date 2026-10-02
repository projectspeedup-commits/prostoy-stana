# Контекст сборки — корень проекта: docker build -f app/Dockerfile .
FROM node:24-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev && npm cache clean --force
COPY app/ /app/app/
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV STAN_DATA_DIR=/app/data PORT=8080 HOST=0.0.0.0 NODE_ENV=production TZ=Europe/Moscow

VOLUME /app/data
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "app/server/index.js"]
