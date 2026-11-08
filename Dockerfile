FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/ya0yy/ai-token-dashboard" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY db ./db
COPY config ./config
COPY public ./public
COPY data/pricing-litellm.json data/pricing-openrouter.json ./data/
COPY index.html vite.config.js ./
RUN npm run build && npm prune --omit=dev

ENV PORT=4173 HOST=0.0.0.0
EXPOSE 4173

CMD ["node", "src/server.mjs"]
