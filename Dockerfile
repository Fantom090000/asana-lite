FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production 2>/dev/null || npm install --only=production

COPY . .

RUN mkdir -p /app/data /app/chat_files

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

VOLUME ["/app/data", "/app/chat_files"]

CMD ["node", "server.js"]