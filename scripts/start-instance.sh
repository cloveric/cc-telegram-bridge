#!/usr/bin/env bash
set -euo pipefail

INSTANCE="${1:-default}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

node dist/src/index.js telegram service start --instance "$INSTANCE"
