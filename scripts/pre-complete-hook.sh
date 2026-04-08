#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "[pre-complete] running test suite..."
npm test

echo "[pre-complete] running build..."
npm run build

echo "[pre-complete] verification passed."
