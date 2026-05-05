# Use Microsoft's official Playwright image — has Chromium + all OS deps preinstalled.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
