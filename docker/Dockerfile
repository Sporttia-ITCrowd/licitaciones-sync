# syntax=docker/dockerfile:1.7

FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle

RUN npm run build


FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV TMP_DIR=/tmp/placsp

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle

USER node
CMD ["node", "dist/index.js"]
