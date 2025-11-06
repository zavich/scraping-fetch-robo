# ---------- STAGE 1: BUILD ----------
FROM node:18-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# ---------- STAGE 2: RUN ----------
FROM node:18-slim

# Instala dependências completas do Chromium (essencial p/ TRT-15)
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
    wget \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer não baixa Chromium porque usaremos o do SO
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

EXPOSE 8081
CMD ["dumb-init", "node", "dist/main"]
