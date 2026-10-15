#!/usr/bin/env bash
#
# verify-pe-arch.sh — assert that shipped Windows binaries really are the
# architecture we claim they are.
#
# Why this exists
# ---------------
# The packaging jobs cross-compile: an ARM64 sidecar and an ARM64 Electron app
# are produced on an x64 runner. If a download, a cache hit or a matrix flag
# silently yields the wrong architecture, every existing check still passes —
# the workflow only asserts that the *strings* `--x64` / `--arm64` appear in the
# YAML (tests/test-desktop-identity.test.js), never that the produced PE files
# match. The failure mode is a release that installs on x64 and dies on ARM64
# (or vice versa) with no CI signal at all.
#
# This reads the PE `Machine` field straight out of the file header, so it
# cannot be fooled by filenames or by which matrix row ran.
#
# Usage:
#   verify-pe-arch.sh <x64|arm64> <file> [file...]
#
# Exits non-zero if any file is missing, is not a PE, or has the wrong machine.
# Pure bash + od so it runs in Git Bash on the Windows runners.

set -euo pipefail

EXPECTED="${1:?usage: verify-pe-arch.sh <x64|arm64> <file> [file...]}"
shift
# Normalise so `ARM64` / `X64` are accepted. Matrix values are lowercase today,
# but a case difference must not be mistaken for an architecture mismatch.
EXPECTED="$(printf '%s' "$EXPECTED" | tr '[:upper:]' '[:lower:]')"

case "$EXPECTED" in
  x64|amd64)   WANT="8664"; HUMAN="x64 (AMD64)" ;;
  arm64|aarch64) WANT="aa64"; HUMAN="ARM64" ;;
  *)
    echo "verify-pe-arch.sh: unknown architecture '$EXPECTED' (expected x64 or arm64)" >&2
    exit 2
    ;;
esac

if ! command -v od >/dev/null 2>&1; then
  echo "verify-pe-arch.sh: 'od' is required but was not found" >&2
  exit 2
fi

# Read the little-endian PE Machine field.
#   e_lfanew  : 4 bytes at 0x3C -> offset of the PE header
#   Machine   : 2 bytes at (PE header + 4)
pe_machine() {
  local file="$1" lfanew b0 b1 b2 b3 peoff m0 m1
  lfanew=$(od -An -tu1 -j60 -N4 "$file" | tr -s ' ' '\n' | grep -v '^$')
  b0=$(echo "$lfanew" | sed -n 1p)
  b1=$(echo "$lfanew" | sed -n 2p)
  b2=$(echo "$lfanew" | sed -n 3p)
  b3=$(echo "$lfanew" | sed -n 4p)
  peoff=$(( b0 + b1*256 + b2*65536 + b3*16777216 ))
  m0=$(od -An -tu1 -j$(( peoff + 4 )) -N1 "$file" | tr -d ' ')
  m1=$(od -An -tu1 -j$(( peoff + 5 )) -N1 "$file" | tr -d ' ')
  printf '%02x%02x' "$m1" "$m0"
}

fail=0
checked=0

for f in "$@"; do
  if [ ! -f "$f" ]; then
    echo "  MISSING  $f" >&2
    fail=1
    continue
  fi

  # Guard against a non-PE (e.g. a stray text file or an LZMA archive).
  if [ "$(od -An -c -N2 "$f" | tr -d ' ')" != "MZ" ]; then
    echo "  NOT-PE   $f" >&2
    fail=1
    continue
  fi

  got=$(pe_machine "$f")
  checked=$(( checked + 1 ))

  if [ "$got" = "$WANT" ]; then
    echo "  OK       $f  ($HUMAN)"
  else
    echo "  WRONG    $f  expected $HUMAN (0x$WANT) but found 0x$got" >&2
    fail=1
  fi
done

if [ "$checked" -eq 0 ] && [ "$fail" -eq 0 ]; then
  echo "verify-pe-arch.sh: no files given to check" >&2
  exit 2
fi

if [ "$fail" -ne 0 ]; then
  echo "verify-pe-arch.sh: architecture check FAILED for $EXPECTED" >&2
  exit 1
fi

echo "verify-pe-arch.sh: all $checked file(s) verified as $HUMAN"
