# Quiet startup (no NATS / no Chainlink RPC)

Copy these into `.env` for **direct mode** (dashboard HTTP + Binance feeds, no broker, no Polygon RPC):

```bash
# NATS off — no CONNECTION_REFUSED
NATS_URL=disabled
USE_NATS=false
BOT_USE_NATS_FEEDS=false

# Chainlink off — Binance kline for price-to-beat (default when POLYGON_RPC unset)
# POLYGON_RPC=
```

## Optional Chainlink

Use a **paid or keyed** Polygon RPC (public `polygon-rpc.com` often 401):

```bash
POLYGON_RPC=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
ENABLE_CHAINLINK=true
```

## Optional NATS stack

```bash
npm run nats:up
NATS_URL=nats://127.0.0.1:4222
USE_NATS=true
USE_NATS_FEEDS=true
BOT_USE_NATS_FEEDS=true
```

If `USE_NATS=true` but the broker is not running, you get **one** startup warning; bot and dashboard still work via HTTP (`/api/bot-event`, dashboard bot controls).
