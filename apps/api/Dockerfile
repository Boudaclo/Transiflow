# Debian (glibc) et non Alpine : argon2 fournit un binaire précompilé fiable pour glibc.
# Les outils de compilation ne servent que de secours et restent dans l'étape de build.
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
COPY apps/web/package.json apps/web/package.json
RUN npm ci -w apps/api -w packages/shared
RUN npm run build:shared && npm run build -w apps/api

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
USER node
EXPOSE 3000
CMD ["sh", "-c", "node apps/api/dist/migrate-cli.js && node apps/api/dist/bootstrap-admin.js && node apps/api/dist/main.js"]
