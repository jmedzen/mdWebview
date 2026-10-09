FROM node:24-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy all essential application files
COPY server.js app.js index.html style.css render-worker.js index-worker.js md-worker.js marked.min.js s2t.js ./
COPY lib/ ./lib/
COPY vendor/ ./vendor/
COPY manifest.json sw.js icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png favicon-16.png favicon-32.png favicon.ico favicon.svg icon.svg og-preview.png ./

# Create data, logs, md, and dicts directory
RUN mkdir -p /data /data/logs /data/md /data/dicts

# Default environment variables
# Note: Full vault bigram index .bin is ~650MB; index build peak RAM requires >= 2x index size.
# Container RAM is recommended to have at least 4GB (recommended 8GB).
ENV PORT=8330 \
    CONFIG_PATH=/data/config.json \
    LOG_DIR=/data/logs \
    MD_ROOT=/data/md \
    DICTIONARY_PATH=/data/dicts \
    TRUST_PROXY=true \
    NODE_OPTIONS="--max-old-space-size=6144"

# Expose default port
EXPOSE 8330

# Start server
CMD ["node", "server.js"]
