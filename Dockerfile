# Step 1: Base image with Node.js
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

# Step 2: Set working directory
WORKDIR /usr/src/app

# Step 3: Install app dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Step 4: Copy source code
COPY . .

# Step 5: Build the app (transpile TypeScript)
RUN npm run build

# Step 6: Expose the port NestJS runs on
EXPOSE 8081

# Step 7: Start the app
CMD ["dumb-init", "node", "dist/main"]
