FROM node:24-alpine

WORKDIR /app

# Copy package files and install exactly the locked production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force \
 && apk add --no-cache su-exec

# Copy all essential application files
COPY server.js app.js index.html style.css render-worker.js index-worker.js md-worker.js marked.min.js ./
COPY lib/ ./lib/
COPY i18n/ ./i18n/
COPY vendor/ ./vendor/
COPY manifest.json sw.js icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png favicon-16.png favicon-32.png favicon.ico favicon.svg icon.svg og-preview.png ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Create data, logs, md, and dicts directory. The application code stays
# root-owned (read-only for the server); only /data/logs and the config are
# writable by the unprivileged `node` user (see docker-entrypoint.sh).
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data /data/logs /data/md /data/dicts \
 && chown node:node /data /data/logs

# Default environment variables
# Note: Full vault bigram index .bin is ~650MB; index build peak RAM requires >= 2x index size.
# Container RAM is recommended to have at least 4GB (recommended 8GB).
# TRUST_PROXY=true trusts X-Forwarded-For / CF-Connecting-IP only from loopback
# and private peers (cloudflared, Docker bridge, a proxy on the same host).
ENV PORT=8330 \
    CONFIG_PATH=/data/config.json \
    LOG_DIR=/data/logs \
    MD_ROOT=/data/md \
    DICTIONARY_PATH=/data/dicts \
    TRUST_PROXY=true \
    NODE_OPTIONS="--max-old-space-size=6144"

# Expose default port
EXPOSE 8330

# Start server (the entrypoint drops root privileges before exec'ing node)
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
