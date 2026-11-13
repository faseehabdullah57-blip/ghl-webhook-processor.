FROM node:20-alpine

WORKDIR /usr/src/app

# Copy package manifests first for optimal Docker layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy application source
COPY src ./src
COPY data ./data

# Ensure persistent volume directories exist and are owned by non-root node user
RUN mkdir -p /usr/src/app/data /usr/src/app/logs && \
    chown -R node:node /usr/src/app

USER node

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
