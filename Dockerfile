# Build stage: compile server (tsc) and web (vite)
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage: production deps only, server serves API + built SPA
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
ENV PORT=3001
EXPOSE 3001
# Populate the DB on first boot (seed by default; PLANVIEW_BOOTSTRAP=ingest for live data)
CMD ["sh", "-c", "node server/dist/bootstrap.js && node server/dist/index.js"]
