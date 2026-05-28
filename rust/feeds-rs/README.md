# feeds-rs

Low-latency market data publisher for **polymarket_bot**. Streams Binance `aggTrade` and Polymarket BTC 5m/15m up/down markets, normalizes events, and publishes JSON to NATS.

## Build

```bash
cd rust/feeds-rs
cargo build --release
```

Binary: `target/release/feeds-rs`

## Run

Start NATS (example with Docker):

```bash
docker run --rm -p 4222:4222 nats:2.10 -js
```

Run the feed service:

```bash
export NATS_URL=nats://127.0.0.1:4222
export MARKET_WINDOW=15   # 5 | 15 | both
./target/release/feeds-rs
```

Optional env (see project `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `NATS_URL` | `nats://127.0.0.1:4222` | NATS server |
| `MARKET_WINDOW` | `15` | `5`, `15`, or `both` |
| `BINANCE_WS_URL` | Binance BTC aggTrade | Override WS URL |
| `ORDERBOOK_POLL_MS` | `1000` | REST orderbook poll (vs Node dashboard `2500`) |
| `MIDPOINT_FALLBACK_MS` | `5000` | REST midpoint backup |
| `MARKET_REFRESH_MS` | `45000` | Gamma market rediscovery |
| `RUST_LOG` | `info` | `tracing` filter |

Subscribe to samples:

```bash
nats sub 'feeds.>' 
```

## NATS subjects

| Subject | `type` | Description |
|---------|--------|-------------|
| `feeds.binance.price` | `price` | BTCUSDT aggTrade |
| `feeds.polymarket.price` | `price` | Yes/no token prices |
| `feeds.polymarket.orderbook` | `orderbook` | Top-of-book snapshot (REST) |
| `feeds.polymarket.markets` | `markets` | Active filtered market list |

### Event schema (JSON)

Common fields on all events:

- `source`: `"binance"` \| `"polymarket"`
- `type`: `"price"` \| `"orderbook"` \| `"markets"`
- `ts_ms`: publish timestamp (ms)
- `market_id`: condition id or `BTCUSDT` (when applicable)
- `yes_price`, `no_price`, `price`: optional floats
- `window_minutes`: `5` or `15` for Polymarket short windows
- `via`: transport hint (`aggTrade`, `ws`, `clob_rest`, `midpoint_rest`, `gamma_rest`)

Example Binance price:

```json
{
  "source": "binance",
  "type": "price",
  "market_id": "BTCUSDT",
  "price": 104321.12,
  "ts_ms": 1716912345678,
  "symbol": "BTCUSDT",
  "via": "aggTrade"
}
```

Example Polymarket price:

```json
{
  "source": "polymarket",
  "type": "price",
  "market_id": "0x…",
  "yes_price": 0.52,
  "no_price": 0.48,
  "ts_ms": 1716912345678,
  "window_minutes": 15,
  "side": "yes",
  "via": "ws",
  "question": "Bitcoin Up or Down …",
  "end_time_ms": 1716912900000
}
```

## Architecture

```
┌─────────────┐     aggTrade WS      ┌──────────────┐
│   Binance   │ ───────────────────► │  feeds-rs    │
└─────────────┘                      │  (tokio)     │
┌─────────────┐  price WS + Gamma REST │              │
│ Polymarket  │ ───────────────────► │  normalize   │──► NATS
└─────────────┘  CLOB REST fallback   └──────────────┘
```

- **Hot path**: WebSocket receive loops parse minimal JSON and publish immediately (no orderbook fetch on every tick).
- **Market filter**: Mirrors `api/polymarket_runtime.js` — BTC 5m/15m only, nearest live expiry windows.
- **Orderbook**: Parallel REST polls on a fixed interval (default 1s), not coupled to price WS.

## Latency vs Node dashboard

| Path | Node (`dashboard/server.js`) | feeds-rs |
|------|------------------------------|----------|
| Binance | WS in Node event loop | Dedicated Rust WS task |
| Polymarket price | WS + midpoint poll 5s | WS + midpoint fallback 5s |
| Orderbook | REST every **2.5s**, often triggered again on **each** price tick | REST every **1s**, decoupled from prices |
| Fan-out | In-process WebSocket to browser | NATS pub/sub (any consumer) |

Expect **~1–5 ms** parse/publish overhead in Rust vs **tens of ms** under Node load, plus lower tail latency when the dashboard is busy. End-to-end latency still includes network RTT to Binance/Polymarket and NATS.

## Caveats (MVP)

- Polymarket **orderbook** snapshots use REST; CLOB market WS can emit book/price deltas (parsed when present).
- Default WS is `wss://ws-subscriptions-clob.polymarket.com/ws/market` (the legacy `ws-live-data` URL returns 403).
- No Chainlink oracle feed in this crate (still in Node `api/feeds.js`).
- Requires a running NATS server; Node bot/dashboard unchanged until wired to subscribe.
- Gamma/CLOB rate limits apply; reduce `MAX_POLY_MARKETS` if needed.
