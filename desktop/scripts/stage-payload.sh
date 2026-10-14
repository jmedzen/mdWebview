#!/usr/bin/env bash
#
# stage-payload.sh — copy the read-only application payload into a staging dir.
#
# The desktop bundles must contain the server and its assets, but NOT the
# writable trees (logs/, md/, dicts/, data/) nor the multi-hundred-MB index
# caches. This script performs that copy with a single explicit allow-list so
# the two shells (Electron and Tauri) stay in sync.

set -euo pipefail

SRC="${1:?usage: stage-payload.sh <source-root> <dest-dir>}"
DEST="${2:?missing destination directory}"

SRC="$(cd "$SRC" && pwd)"
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"

# Files and directories that make up the application payload.
FILES=(
  server.js app.js index.html style.css sw.js manifest.json
  md-worker.js render-worker.js index-worker.js marked.min.js s2t.js
  package.json
  icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png
  favicon-16.png favicon-32.png favicon.ico favicon.svg icon.svg og-preview.png
)
DIRS=(
  lib vendor
)

for f in "${FILES[@]}"; do
  if [ -e "$SRC/$f" ]; then
    cp "$SRC/$f" "$DEST/$f"
  else
    echo "warning: missing payload file: $f" >&2
  fi
done

for d in "${DIRS[@]}"; do
  if [ -d "$SRC/$d" ]; then
    mkdir -p "$DEST/$d"
    cp -R "$SRC/$d/." "$DEST/$d/"
  else
    echo "warning: missing payload directory: $d" >&2
  fi
done

# `marked` is the only runtime dependency and must be resolvable by
# `require('marked')` from render-worker.js.
if [ -d "$SRC/node_modules/marked" ]; then
  mkdir -p "$DEST/node_modules"
  cp -R "$SRC/node_modules/marked" "$DEST/node_modules/marked"
else
  echo "error: node_modules/marked is required by render-worker.js" >&2
  exit 1
fi

# config.json is deliberately excluded: in a desktop bundle the application
# directory is read-only and shared by all users of the machine, while the real
# configuration lives in the per-user data directory (CONFIG_PATH).
rm -f "$DEST/config.json"

# Sanity checks — these files are required at runtime.
for required in server.js render-worker.js index-worker.js marked.min.js lib/constants.js; do
  if [ ! -e "$DEST/$required" ]; then
    echo "error: staged payload is missing $required" >&2
    exit 1
  fi
done
if [ ! -e "$DEST/node_modules/marked/package.json" ]; then
  echo "error: staged payload is missing node_modules/marked" >&2
  exit 1
fi

echo "==> Payload staged at $DEST"
du -sh "$DEST" 2>/dev/null || true
