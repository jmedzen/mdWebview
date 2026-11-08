#!/bin/sh
# mdWebview container entrypoint.
#
# The server must not run as root: an administrator who points the vault at a
# broad directory, or any future read bug, would otherwise expose files only
# root can read (/etc/shadow, other containers' secrets on shared mounts).
#
# Existing deployments bind-mount ./data and ./logs, which a previous root
# container may have created as root-owned. When started as root we therefore
# hand ONLY the paths the server writes to (config file + its directory, the
# logs directory, the index/ search-cache directory, the users.db account database and its backups) to the unprivileged `node` user, then drop
# privileges. The vault (MD_ROOT) and dictionaries are only read, so their
# ownership on the host is never changed.
set -e

if [ "$(id -u)" = "0" ]; then
  CONFIG_FILE="${CONFIG_PATH:-/data/config.json}"
  CONFIG_DIR="$(dirname "$CONFIG_FILE")"
  LOGS="${LOG_DIR:-/data/logs}"
  # 搜尋索引快取（v4.19.0 起與 logs 分開）。升級時伺服器會把 logs 裡的舊索引
  # 搬過來，所以兩個目錄都必須交給 node。
  INDEX="${INDEX_DIR:-/data/index}"

  mkdir -p "$CONFIG_DIR" "$LOGS" "$INDEX" 2>/dev/null || true
  chown node:node "$CONFIG_DIR" 2>/dev/null || true
  [ -e "$CONFIG_FILE" ] && chown node:node "$CONFIG_FILE" 2>/dev/null || true
  # A config written atomically may leave a sibling temp file behind.
  for f in "$CONFIG_FILE".tmp*; do [ -e "$f" ] && chown node:node "$f" 2>/dev/null || true; done
  chown -R node:node "$LOGS" 2>/dev/null || true
  chown -R node:node "$INDEX" 2>/dev/null || true
  # 使用者帳號資料庫（SQLite 主檔、WAL、共享記憶體檔）與備份資料夾。
  DB_FILE="${USERS_DB_PATH:-$CONFIG_DIR/users.db}"
  BACKUPS="${DB_BACKUP_DIR:-$(dirname "$DB_FILE")/backups}"
  mkdir -p "$(dirname "$DB_FILE")" "$BACKUPS" 2>/dev/null || true
  chown node:node "$(dirname "$DB_FILE")" 2>/dev/null || true
  # secrets.key：後台網頁填寫的寄信／Turnstile 金鑰的加密金鑰。
  for f in "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-shm" "$(dirname "$DB_FILE")/secrets.key"; do [ -e "$f" ] && chown node:node "$f" 2>/dev/null || true; done
  chown -R node:node "$BACKUPS" 2>/dev/null || true

  # su-exec execs the command directly (no intermediate shell or fork), so
  # node stays PID 1 and receives SIGTERM itself — graceful shutdown works.
  exec su-exec node "$@"
fi

exec "$@"
