FROM node:24-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy all essential application files
COPY server.js app.js index.html style.css render-worker.js index-worker.js md-worker.js marked.min.js ./

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
