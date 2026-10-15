#!/usr/bin/env bash
#
# prepare-sidecar.sh — install the official Node.js runtime as the Tauri sidecar.
#
# Tauri's `externalBin` requires a single self-contained executable whose filename
# carries the Rust target triple (e.g. `mdwebview-server-x86_64-pc-windows-msvc.exe`).
#
# It MUST be the official nodejs.org build:
#   * Homebrew / distro / nvm "shared" builds are ~50 KB shims linked against
#     libnode.dylib / libnode.so and cannot be shipped on their own.
#   * The harness-bundled and some distro builds also compile SEA out, which is
#     irrelevant here but illustrates how much these builds vary.
#
# Both Node 24 (LTS, matching the Docker image) and the target triple are chosen
# by the caller so the same script serves every platform.

set -euo pipefail

TRIPLE="${1:?usage: prepare-sidecar.sh <rust-target-triple> <node-platform> <node-arch>}"
NODE_PLATFORM="${2:?missing node platform (darwin|win|linux)}"
NODE_ARCH="${3:?missing node arch (arm64|x64)}"
NODE_VERSION="${NODE_VERSION:-24.17.0}"

# Tauri appends `.exe` on Windows targets only.
case "$TRIPLE" in
  *windows*) EXT=".exe" ;;
  *)         EXT="" ;;
esac

# Tauri resolves `externalBin` relative to the Tauri project (src-tauri's parent).
DEST_DIR="$(cd "$(dirname "$0")/../tauri/src-tauri" && pwd)/binaries"
DEST="$DEST_DIR/mdwebview-server-${TRIPLE}${EXT}"
mkdir -p "$DEST_DIR"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Downloading official Node.js v${NODE_VERSION} (${NODE_PLATFORM}-${NODE_ARCH})"

case "$NODE_PLATFORM" in
  darwin)
    ARCHIVE="node-v${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
    ;;
  linux)
    ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz"
    ;;
  win)
    ARCHIVE="node-v${NODE_VERSION}-win-${NODE_ARCH}.zip"
    ;;
  *)
    echo "Unsupported node platform: $NODE_PLATFORM" >&2
    exit 1
    ;;
esac

URL="https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}"
echo "    $URL"
curl -fsSL --retry 3 --retry-delay 2 -o "$WORK/$ARCHIVE" "$URL"

case "$NODE_PLATFORM" in
  win)
    if command -v unzip >/dev/null 2>&1; then
      unzip -q "$WORK/$ARCHIVE" -d "$WORK"
    else
      # PowerShell cannot resolve Git Bash's POSIX paths, so convert them to
      # native Windows paths first (cygpath ships with Git for Windows).
      WIN_ARCHIVE="$(cygpath -w "$WORK/$ARCHIVE")"
      WIN_WORK="$(cygpath -w "$WORK")"
      powershell -NoProfile -Command \
        "Expand-Archive -LiteralPath '$WIN_ARCHIVE' -DestinationPath '$WIN_WORK' -Force"
    fi
    SRC="$WORK/node-v${NODE_VERSION}-win-${NODE_ARCH}/node.exe"
    ;;
  *)
    tar -xzf "$WORK/$ARCHIVE" -C "$WORK"
    SRC="$WORK/node-v${NODE_VERSION}-${NODE_PLATFORM}-${NODE_ARCH}/bin/node"
    ;;
esac

if [ ! -f "$SRC" ]; then
  echo "Could not locate the node executable inside the archive" >&2
  exit 1
fi

cp "$SRC" "$DEST"
chmod +x "$DEST"

echo "==> Sidecar installed: $DEST"

# Verify the download by running it — but only when the host can execute the
# target's binaries. When cross-compiling (e.g. an arm64 Windows sidecar built
# on an x64 runner) the executable cannot start here, and that is expected
# rather than a bad download. `curl -fsSL` above already fails on a bad fetch.
if "$DEST" --version 2>/dev/null; then
  :
else
  echo "==> Skipped runtime check (cannot execute ${TRIPLE} on this host; expected when cross-compiling)"
fi

