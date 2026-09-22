FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY backend/package.json backend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY mobile/package.json mobile/package.json
COPY admin-dashboard/package.json admin-dashboard/package.json
RUN npm ci
COPY admin-dashboard admin-dashboard
ARG GOOGLE_MAPS_API_KEY
ARG GOOGLE_MAPS_MAP_ID
ENV GOOGLE_MAPS_API_KEY=$GOOGLE_MAPS_API_KEY GOOGLE_MAPS_MAP_ID=$GOOGLE_MAPS_MAP_ID
RUN npm run admin:build

FROM nginxinc/nginx-unprivileged:stable-alpine
COPY admin-dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/admin-dashboard/dist /usr/share/nginx/html
EXPOSE 8080
