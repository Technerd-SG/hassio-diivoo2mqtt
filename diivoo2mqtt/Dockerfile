ARG BUILD_FROM=ghcr.io/home-assistant/base:latest
ARG BUILD_VERSION=dev
ARG BUILD_ARCH=amd64

FROM node:22-alpine AS frontend-builder
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS backend-builder
WORKDIR /build/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./

FROM ${BUILD_FROM}

ARG BUILD_VERSION
ARG BUILD_ARCH

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

RUN apk add --no-cache nodejs

WORKDIR /app

COPY --from=backend-builder /build/backend /app/backend
COPY --from=frontend-builder /build/frontend/dist /app/backend/public
COPY run.sh /run.sh

RUN chmod a+x /run.sh

CMD ["/run.sh"]