# # ---------- STAGE 1: BUILD ----------
# FROM node:18-alpine AS build

# WORKDIR /app

# # Instala dependências necessárias para o build
# COPY package*.json ./
# RUN npm install

# # Copia o código-fonte e compila o projeto
# COPY . .
# RUN npm run build

# # ---------- STAGE 2: RUN ----------
# FROM node:18-alpine

# # Instala Chromium e dependências necessárias para Puppeteer
# RUN apk add --no-cache \
#     chromium \
#     nss \
#     freetype \
#     harfbuzz \
#     ca-certificates \
#     ttf-freefont \
#     dumb-init \
#     udev \
#     xvfb \
#     && rm -rf /var/cache/apk/*

# # Define variáveis para o Puppeteer usar o Chromium instalado
# ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
# ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
# ENV NODE_ENV=production

# WORKDIR /usr/src/app

# # Copia apenas o build e as dependências necessárias
# COPY package*.json ./
# RUN npm ci --omit=dev

# COPY --from=build /app/dist ./dist

# EXPOSE 8081
# CMD ["dumb-init", "node", "dist/main"]
# ---------- STAGE 1: BUILD ----------
FROM node:18-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# ---------- STAGE 2: RUN ----------
FROM node:18-slim

RUN apt-get update && apt-get install -y \
    chromium \
    chromium-common \
    chromium-driver \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libgtk-3-0 \
    libasound2 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libpangocairo-1.0-0 \
    libcups2 \
    libxss1 \
    libxtst6 \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

EXPOSE 8081
CMD ["dumb-init", "node", "dist/main"]
