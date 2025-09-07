# syntax=docker/dockerfile:1

# --- Build Stage ---
FROM node:20-alpine AS builder
WORKDIR /app

# Install deps (clean, reproducible) and build TS -> dist
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime Stage ---
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# Only production deps
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Persist tokens outside the image
VOLUME ["/app/auths"]

EXPOSE 1456
CMD ["node", "dist/index.js"]

