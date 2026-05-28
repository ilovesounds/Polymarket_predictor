#!/usr/bin/env sh
set -e
cd "$(dirname "$0")/.."
if command -v docker >/dev/null 2>&1; then
  docker compose up -d nats
  echo "NATS: nats://127.0.0.1:4222 (monitor http://127.0.0.1:8222)"
  exit 0
fi
if command -v nats-server >/dev/null 2>&1; then
  echo "Docker unavailable; start nats-server manually:"
  echo "  nats-server -js -m 8222"
  exit 1
fi
echo "Install Docker or nats-server (brew install nats-server)"
exit 1
