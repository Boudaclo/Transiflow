FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
COPY apps/api/package.json apps/api/package.json
# Seulement le site web et le module partagé : pas besoin des dépendances de l'API (argon2, pg…)
RUN npm ci -w apps/web -w packages/shared -w packages/offline
# Les paquets du monorepo sont lus depuis leurs sources (alias Vite) : pas de pré-build.
RUN npm run build -w apps/web

FROM nginx:1.27-alpine
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
