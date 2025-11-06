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

# Copia arquivos do Node
COPY package*.json ./

# Instala dependências incluindo canvas
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

RUN npm install

# Copia código
COPY . .

# Compila Nest
RUN npm run build


# ---------- STAGE 2: RUN ----------
FROM node:18-slim

# Instala Chromium e libs para Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-common \
    chromium-driver \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libcups2 \
    libnss3 \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production

WORKDIR /usr/src/app

# Copia node_modules já compilado (incluindo canvas)
COPY --from=build /app/node_modules ./node_modules

# Copia os arquivos compilados
COPY --from=build /app/dist ./dist

COPY package*.json ./

EXPOSE 8081
CMD ["node", "dist/main"]
