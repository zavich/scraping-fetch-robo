# ---------- STAGE 1: BUILD ----------
FROM node:18-slim AS build

WORKDIR /app

# Dependências para build (canvas, etc)
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Instala deps
COPY package*.json ./
RUN npm install

# Copia código e builda
COPY . .
RUN npm run build


# ---------- STAGE 2: RUN ----------
FROM node:18-slim

WORKDIR /usr/src/app

# Instala Chromium + libs necessárias
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-common \
    chromium-driver \
    dumb-init \
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
    libcairo2 \
    libpango-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    ca-certificates \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Variáveis para Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROME_PATH=/usr/bin/chromium
ENV NODE_ENV=production

# Copia dependências já buildadas
COPY --from=build /app/node_modules ./node_modules

# Copia build da aplicação
COPY --from=build /app/dist ./dist

COPY package*.json ./

# Porta da aplicação
EXPOSE 8081

# Inicia com dumb-init (evita processos zumbi)
CMD ["dumb-init", "node", "--max-old-space-size=4096", "dist/main"]