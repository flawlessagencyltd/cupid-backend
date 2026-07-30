FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production --no-audit --no-fund
COPY index.js server.js tracking.js db.js geo.js http.js ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
