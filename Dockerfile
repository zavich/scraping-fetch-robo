# ---------- STAGE 1: BUILD ----------
FROM node:18-alpine AS build

WORKDIR /app

# Instala dependências necessárias para o build
COPY package*.json ./
RUN npm install

# Copia o código-fonte e compila o projeto
COPY . .
RUN npm run build

# ---------- STAGE 2: RUN ----------
FROM node:18-alpine

# Instala Chromium e dependências necessárias para Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    dumb-init \
    udev \
    xvfb \
    && rm -rf /var/cache/apk/*

# Define variáveis para o Puppeteer usar o Chromium instalado
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production

WORKDIR /usr/src/app

# Copia apenas o build e as dependências necessárias
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

EXPOSE 8081
CMD ["dumb-init", "node", "dist/main"]
