FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --chown=node:node migrations ./migrations
COPY --chown=node:node app ./app

USER node

EXPOSE 3000

CMD ["node", "app/index.js"]
