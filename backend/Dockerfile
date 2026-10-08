FROM node:22-slim

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci

COPY backend/ ./
COPY frontend /app/frontend

ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
