FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend

WORKDIR /build
COPY package.json package-lock.json ./
# 依赖审计由CI独立执行，前端始终在构建机原生架构上编译。
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY index.html vite.config.js ./
RUN npm run build

FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.source="https://github.com/ya0yy/ai-token-dashboard" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY package.json package-lock.json LICENSE ./
# 各目标架构只安装生产依赖，不把构建阶段的开发依赖层带入运行镜像。
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY db ./db
COPY config ./config
COPY data/pricing-litellm.json data/pricing-openrouter.json ./data/
COPY --from=frontend /build/dist ./dist

ENV PORT=4173 HOST=0.0.0.0
EXPOSE 4173
CMD ["node", "src/server.mjs"]
