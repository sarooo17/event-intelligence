FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY bin ./bin

EXPOSE 3000

CMD ["node", "scripts/service.mjs"]
