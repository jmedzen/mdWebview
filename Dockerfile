FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy all essential application files
COPY server.js app.js index.html style.css render-worker.js md-worker.js marked.min.js ./

# Create data and md directory
RUN mkdir -p /data /app/md

# Default environment variables
ENV PORT=8330 \
    CONFIG_PATH=/data/config.json \
    MD_ROOT=/data/md \
    SITE_NAME="mdWebview" \
    ENABLE_VERSION=false \
    VERSION="" \
    ENABLE_DOWNLOAD=false \
    DOWNLOAD_URL=""

# Expose default port
EXPOSE 8330

# Start server
CMD ["node", "server.js"]
