FROM node:24-alpine

WORKDIR /app

# Copy package files and install exactly the locked production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force \
 && apk add --no-cache su-exec

# 早安圖（每日經句分享卡）由伺服器畫，需要宋體：建置時從 Google Fonts 下載 Noto Serif TC（SIL OFL）。
# 下載失敗不讓建置失敗——之後也可以把字型放到 /data/fonts/。
RUN mkdir -p /app/fonts && for w in 500 700 900; do \
      url=$(wget -qO- "https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@${w}" | grep -o 'https://[^)]*\.ttf' | head -n 1); \
      if [ -n "$url" ] && wget -qO "/app/fonts/NotoSerifTC-${w}.ttf" "$url"; then echo "font ${w} ok"; \
      else rm -f "/app/fonts/NotoSerifTC-${w}.ttf"; echo "WARNING: Noto Serif TC ${w} download failed"; fi; \
    done

# Copy all essential application files
COPY server.js app.js library-sync.js highlights.js kepan-sidebar.js share-card.js index.html style.css render-worker.js index-worker.js md-worker.js marked.min.js ./
COPY lib/ ./lib/
COPY i18n/ ./i18n/
COPY vendor/ ./vendor/
COPY manifest.json sw.js icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png favicon-16.png favicon-32.png favicon.ico favicon.svg icon.svg og-preview.png ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Create data, logs, index, md, and dicts directory. The application code stays
# root-owned (read-only for the server); only /data/logs, /data/index and the
# config are writable by the unprivileged `node` user (see docker-entrypoint.sh).
# /data/index 放搜尋索引快取（全庫約 650MB，可重建、不必備份）；建議用獨立的
# volume／bind mount（docker-compose.yml 的 ./index），重建容器時才不必重新建索引。
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data /data/logs /data/index /data/md /data/dicts \
 && chown node:node /data /data/logs /data/index

# Default environment variables
# Note: Full vault bigram index .bin is ~650MB; index build peak RAM requires >= 2x index size.
# Container RAM is recommended to have at least 4GB (recommended 8GB).
# TRUST_PROXY=true trusts X-Forwarded-For / CF-Connecting-IP only from loopback
# and private peers (cloudflared, Docker bridge, a proxy on the same host).
# 使用者帳號存在 /data/users.db（與 config.json 同一個目錄，已在 ./data 掛載點內），
# 每日備份在 /data/backups。node:sqlite 仍標示為實驗性，關掉每次啟動的警告。
ENV PORT=8330 \
    CONFIG_PATH=/data/config.json \
    LOG_DIR=/data/logs \
    INDEX_DIR=/data/index \
    MD_ROOT=/data/md \
    DICTIONARY_PATH=/data/dicts \
    TRUST_PROXY=true \
    NODE_OPTIONS="--max-old-space-size=6144 --disable-warning=ExperimentalWarning"

# Expose default port
EXPOSE 8330

# /api/health 會檢查帳號資料庫是否可用（失敗回 503）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1

# Start server (the entrypoint drops root privileges before exec'ing node)
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
