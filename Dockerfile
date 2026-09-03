FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    DATABASE_PATH=/data/proxies.db

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8000
CMD ["npm", "start"]
