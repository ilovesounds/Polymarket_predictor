#!/usr/bin/env sh
set -e
cd "$(dirname "$0")/.."
if command -v docker >/dev/null 2>&1; then
  docker compose down
  exit 0
fi
echo "Stop local nats-server process manually if running."
exit 0
