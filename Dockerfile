FROM node:24-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy all essential application files
COPY server.js app.js index.html style.css render-worker.js index-worker.js md-worker.js marked.min.js s2t.js ./
COPY vendor/ ./vendor/
COPY manifest.json sw.js icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png favicon-32.png icon.svg og-preview.png ./

# Create data, logs, md, and dicts directory
RUN mkdir -p /data /data/logs /data/md /data/dicts

# Default environment variables
ENV PORT=8330 \
    CONFIG_PATH=/data/config.json \
    LOG_DIR=/data/logs \
    MD_ROOT=/data/md \
    DICTIONARY_PATH=/data/dicts

# Expose default port
EXPOSE 8330

# Start server
CMD ["node", "server.js"]
