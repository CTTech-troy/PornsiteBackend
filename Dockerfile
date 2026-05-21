FROM node:20-alpine AS deps
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=5043
WORKDIR /app/backend

RUN addgroup -S nodeapp && adduser -S nodeapp -G nodeapp

COPY --from=deps /app/backend/node_modules ./node_modules
COPY backend ./

USER nodeapp
EXPOSE 5043

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health/services" || exit 1

CMD ["node", "index.js"]
