# Polymarket BTC Bot

A **paper-trading bot** and local dashboard for Polymarket **BTC up/down** markets (5-minute, 15-minute, and daily windows). The stack streams Binance BTC prices and Polymarket CLOB data, runs pluggable entry strategies (including a Binance microstructure **P(up)** model), simulates trades against a local paper wallet, and exposes a full localhost UI for monitoring and control.

> **Safety:** Live on-chain trading is **hard-disabled**. `PAPER_TRADE=false` is ignored; the bot always runs in paper mode.

---

## Features

| Area | What you get |
|------|----------------|
| **Dashboard** | HTTP + WebSocket UI on port `3847` — live prices, orderbook, bot control, portfolio |
| **Live streams** | Polymarket CLOB WebSocket + Binance `aggTrade` feed (direct mode by default) |
| **Bot control** | Start/stop from `/bot`, named profiles, run limits, strategy selection, live logs |
| **Portfolio** | Per-profile paper wallets, open positions, trade history, cash adjustments |
| **Strategy Lab** | Live microstructure metrics, gate builder, bet sizing presets, apply-to-bot |
| **Microstructure / P(up)** | Binance trade-flow signals → model probability vs Polymarket YES → edge-based entries |
| **Backtest** | CLI engine over resolved markets (PolyBackTest API with CLOB fallback) |
| **Optional NATS stack** | Docker NATS + Node or Rust feed publishers for decoupled low-latency ingest |

In-app documentation (same content, browsable): **http://localhost:3847/docs**

---

## Prerequisites

| Tool | Required | Notes |
|------|----------|-------|
| **Node.js** | Yes | **v18+** LTS recommended (v20+ preferred; `undici` dependency targets Node 20) |
| **npm** | Yes | `npm install` — installs `ethers`, `nats`, `undici`, `ws` |
| **Docker** | Optional | For `npm run nats:up` / `npm run dev:nats` (NATS broker) |
| **Rust / cargo** | Optional | Only if you build `rust/feeds-rs` (`npm run feeds:rust:build`) |
| **Wallet / RPC** | Optional | Paper mode needs no `PRIVATE_KEY`. Polygon RPC only for optional Chainlink oracle |

---

## Quick start

```bash
git clone <your-repo-url> polymarket_bot
cd polymarket_bot
npm install
cp .env.example .env
npm run dashboard
```

Open **http://localhost:3847/live** (or **http://localhost:3847** — redirects to Live).

To run dashboard **and** bot together:

```bash
npm run dev
```

Or start the bot from the UI: open **http://localhost:3847/bot** → choose a profile → **Start bot with profile**.

### Minimal `.env` for first-time local use (quiet direct mode)

Copy `.env.example` to `.env`, then use these values for the simplest path — no Docker, no NATS, no Polygon RPC:

```bash
# Core
PAPER_TRADE=true
STARTING_CASH=20
MARKET_WINDOW=all
SIZING_MODE=compound

# Dashboard
DASHBOARD_PORT=3847
DASHBOARD_POLY_MODE=15m
ENABLE_DASHBOARD_FEED=true

# NATS off (recommended for beginners)
NATS_URL=disabled
USE_NATS=false
BOT_USE_NATS_FEEDS=false

# Strategy (price-based default; switch to microstructure_edge on /bot when ready)
BOT_STRATEGY=deterministic_yes_50
BOT_USE_MICROSTRUCTURE_MODEL=false

# Feeds
BINANCE_WS_URL=wss://stream.binance.com:9443/ws/btcusdt@aggTrade
```

See also [`docs/QUIET-STARTUP.md`](docs/QUIET-STARTUP.md) for a copy-paste NATS-off template.

---

## Environment variables

Copy [`.env.example`](.env.example) to `.env`. Variables below reflect the current codebase.

### Essential (local paper trading)

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPER_TRADE` | `true` | Ignored if `false` — bot is hard-locked to paper mode |
| `STARTING_CASH` | `20` | Initial paper bankroll baseline (also reads legacy `STARTING_BANKROLL`) |
| `MARKET_WINDOW` | `all` | Bot/backtest filter: `5`, `15`, `1440` / `1d`, `both` (5+15), `all` (5+15+1d) |
| `BOT_STRATEGY` | `deterministic_yes_50` | Primary strategy id (see [Bot strategies](#bot-strategies)) |
| `BOT_STRATEGIES` | — | Comma-separated priority list (first match wins), e.g. `microstructure_edge,deterministic_yes_50` |
| `BOT_MARKET_WINDOW` | — | Bot-only window override when spawned from dashboard: `5m`, `15m`, `1d`, `both`, `all` |
| `DASHBOARD_PORT` | `3847` | HTTP + WebSocket port |
| `ENABLE_DASHBOARD_FEED` | `true` | Bot POSTs trade events to dashboard when running |
| `NATS_URL` | `disabled` | Set to `nats://127.0.0.1:4222` to enable NATS; `disabled` turns it off entirely |
| `USE_NATS` | `false` | Dashboard/bot NATS bridge when URL is not `disabled` |

### Bet sizing

| Variable | Default | Description |
|----------|---------|-------------|
| `SIZING_MODE` | `compound` | `compound`, `fixed`, `percent`, `amount_cap`, or `kelly` |
| `POSITION_CASH_FRACTION` | `1` | Fraction of bankroll for compound mode |
| `FIXED_BET_USD` | `5` | Flat USDC per trade when `SIZING_MODE=fixed` |
| `BET_PERCENT_OF_BANKROLL` | — | Percent slice when using percent / amount_cap modes |
| `KELLY_FRACTION_CAP` | `0.08` | Max Kelly fraction of bankroll |

Strategy Lab presets in `data/strategy-active-preset.json` override sizing at runtime (no bot restart required).

### Microstructure / P(up) model

| Variable | Default | Description |
|----------|---------|-------------|
| `BOT_USE_MICROSTRUCTURE_MODEL` | `true` in example | Compute P(up) from Binance aggTrades (auto-on when strategy is `microstructure_edge`) |
| `BOT_EDGE_THRESHOLD` | `0.05` | Minimum edge (P(up) − YES price) to trigger entry, e.g. `0.05` = 5 percentage points |
| `BINANCE_WS_URL` | Binance BTC aggTrade | **Required for microstructure** — must receive full aggTrade payloads (`m`, `q`), not price-only ticks |

### Bot profile & entry timing

Configured on **/bot** or **/lab**; persisted in `data/bot-profile.json` and named profiles in `data/bot-profiles.json`.

| Variable | Description |
|----------|-------------|
| `BOT_PROFILE_ID` | Named profile id → wallet at `data/paper-wallets/{id}.json` |
| `BOT_ENTRY_MAX_SECONDS` | Earliest entry — stored as max seconds *remaining* (5m default `270` → enter after 30s elapsed) |
| `BOT_ENTRY_MIN_SECONDS` | Latest entry — seconds after market start (5m default `270`) |
| `BOT_ENTRY_MIN_PRICE` / `BOT_ENTRY_MAX_PRICE` | Optional YES midpoint band |
| `BOT_STOP_THRESHOLD` | Stop-loss floor (default `0.45`) |
| `BOT_STOP_LOSS_PCT` / `BOT_STOP_LOSS_PRICE` | Optional percent or absolute stop |
| `BOT_TRADES_PER_MARKET` | `single` or `multiple` (re-entry / scale-in) |
| `BOT_RUN_MODE` | `indefinite`, `markets` (stop after N entries), or `time` (stop after N minutes) |
| `BOT_RUN_MARKET_LIMIT` | Entry count limit when mode is `markets` |
| `BOT_RUN_TIME_LIMIT_MINUTES` | Minutes limit when mode is `time` |

**Default entry windows (seconds after market start):**

| Window | Earliest | Latest |
|--------|----------|--------|
| 5m | 30s | 270s |
| 15m | 60s | 840s |
| 1d | 3,600s (1h) | 82,800s (1h before close) |

### Exit mode

| Variable | Description |
|----------|-------------|
| `BOT_EXIT_MODE` | `resolve_only` (default) or `fixed_price` |
| `BOT_EXIT_TARGET_PRICE` / `BOT_TAKE_PROFIT_PRICE` | Sell YES when midpoint ≥ target (paper sim) |

### NATS & feeds (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `USE_NATS_FEEDS` | off | Dashboard ingests `feeds.>` from NATS instead of direct WS |
| `BOT_USE_NATS_FEEDS` | `false` | Bot reads Binance from NATS (microstructure still needs direct aggTrade sidecar) |
| `NATS_CONNECT_TIMEOUT_MS` | `8000` | Fail fast if broker is down |
| `NATS_RECONNECT_MAX_MS` | `30000` | Max reconnect backoff |
| `NATS_DEDUP_MS` | `400` | Dedup window for duplicate NATS messages |
| `NATS_FEED_FALLBACK_MS` | `12000` | Dashboard falls back to direct feeds when NATS is idle |

### Strategy Lab gates

| Variable | Default | Description |
|----------|---------|-------------|
| `LAB_MAX_SPREAD_CENTS` | `5` | Max bid-ask spread |
| `LAB_MIN_DEPTH_USD` | `1000` | Min weaker-side depth near mid |
| `LAB_GATE_MODE` | `warn` | `off`, `warn`, or `block` |

### Wallet / API (optional, unused in paper mode)

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Polygon wallet — not required for paper trading |
| `POLYGON_RPC` | Chainlink oracle polling (use Alchemy/Infura; public RPC often 401) |
| `ENABLE_CHAINLINK` | Enable Chainlink price-to-beat |
| `POLY_API_KEY` / `POLY_API_SECRET` / `POLY_API_PASSPHRASE` | Reserved for future authenticated API use |

### Backtest & logging

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKTEST_WINDOWS` | `200` | Resolved windows to simulate |
| `VERBOSE_TRADE_LOGS` | `true` | Human-readable trade logs |
| `TRADE_LOG_JSON` | `true` | Structured JSON log lines |

---

## Running locally

All commands run from the project root: `/Users/shrianshjaiswal/Desktop/polymarket_bot`

### Main workflows

| Script | Command | What it does |
|--------|---------|--------------|
| **`npm run dashboard`** | `node dashboard/server.js` | Dashboard only — direct Binance + Polymarket feeds (NATS off by default) |
| **`npm run dev`** | `node dashboard/run-dev.js` | Dashboard + paper bot together (`PAPER_TRADE=true`, dashboard feed on) |
| **`npm run paper:live`** | `PAPER_TRADE=true ENABLE_DASHBOARD_FEED=true node bot.js` | Bot only; events appear on `/bot` if dashboard is running |

```bash
# Dashboard UI
npm run dashboard

# Dashboard + bot
npm run dev

# Bot alone (dashboard must be up for UI events)
npm run paper:live

# Bot with strategy override
BOT_STRATEGY=microstructure_edge BOT_EDGE_THRESHOLD=0.05 npm run paper:live
```

### Backtest

Results are **terminal-only**; `/backtest` in the dashboard lists command cheatsheets.

```bash
# 15-minute windows (default when MARKET_WINDOW allows 15)
npm run backtest

# 5-minute windows
npm run backtest:5m

# 1-day windows
MARKET_WINDOW=1d npm run backtest

# Custom sample size
BACKTEST_WINDOWS=100 npm run backtest:5m
```

When `MARKET_WINDOW=both` or `all`, the engine uses **15m** as the primary backtest window.

### Optional: NATS + feed publishers

For beginners, skip this section and use **direct mode** (`NATS_URL=disabled`).

```bash
# Start NATS broker (Docker)
npm run nats:up

# Node feed publisher → NATS
npm run feeds:nats

# Dashboard expecting NATS feeds
npm run dashboard:nats

# Full stack: Docker NATS + feeds + dashboard + bot
npm run dev:nats

# Stop NATS
npm run nats:down
```

**Rust feeds-rs** (lower latency alternative to `feeds:nats`):

```bash
npm run feeds:rust:build
npm run nats:up
export NATS_URL=nats://127.0.0.1:4222
export MARKET_WINDOW=15
npm run feeds:rust
```

See [`rust/feeds-rs/README.md`](rust/feeds-rs/README.md) for subjects and build notes. NATS monitoring UI: **http://localhost:8222**

### Other scripts

| Script | Purpose |
|--------|---------|
| `npm run latency:probe` | CLI probe for Binance/Chainlink stream latency |
| `npm run check:docs` | Warn if `package.json` scripts drift from in-app docs |
| `npm test` | Smoke test for microstructure + P(up) model (`scripts/test-btc-up-model.js`) |

---

## Dashboard pages

Base URL: **http://localhost:3847** (unless `DASHBOARD_PORT` is changed)  
WebSocket: **ws://localhost:3847/ws**

| Route | Page | Purpose |
|-------|------|---------|
| `/`, `/live` | **Live** | Split view: Polymarket + Binance streams; window selector; microstructure cards; **Follow live window** toggle |
| `/orderbook` | **Orderbook** | YES/NO bid/ask ladders and depth for the primary market |
| `/bot` | **Bot** | Start/stop paper bot, profiles, strategy, sizing, run duration, logs |
| `/portfolio` | **Portfolio** | Paper cash, positions, trade history, PnL; cash adjustments |
| `/markets` | **Markets** | Gamma explorer (5m / 15m / 1d tabs); pick primary market for Live/Orderbook |
| `/lab`, `/strategy` | **Strategy Lab** | Microstructure metrics, gate builder, bet sizing, apply preset to bot |
| `/latency` | **Latency** | Stream RTT, oracle age, trade-depth pipeline (SSE + REST) |
| `/backtest` | **Backtest** | CLI command reference (engine runs in terminal) |
| `/docs` | **Docs** | Full in-app documentation |

**Follow live window:** On `/live`, keep the toggle **on** (default) so the dashboard tracks the current BTC window automatically. Turn it **off** to pin a market selected on `/markets`.

---

## Bot strategies

Strategies live in [`signals/strategies_runtime.js`](signals/strategies_runtime.js). The router evaluates `BOT_STRATEGIES` in priority order (first eligible entry wins); otherwise `BOT_STRATEGY` is used.

| ID | Label | Entry rule | Default stop |
|----|-------|------------|--------------|
| `deterministic_yes_50` | Deterministic YES ≥ 0.50 | YES midpoint ≥ 0.50 | 0.45 |
| `conservative_yes_55` | Conservative YES ≥ 0.55 | YES midpoint ≥ 0.55 | 0.50 |
| `momentum_confirmed_yes_50` | YES ≥ 0.50 + momentum up | YES ≥ 0.50 and Binance short momentum up | 0.46 |
| `microstructure_edge` | Microstructure edge (P(up) vs YES) | P(up) − YES ≥ `BOT_EDGE_THRESHOLD` and model ready | 0.45 |

**Select in the UI:** `/bot` → Strategy dropdown → Start bot.

**Select via env:**

```bash
BOT_STRATEGY=microstructure_edge
BOT_EDGE_THRESHOLD=0.05
BOT_USE_MICROSTRUCTURE_MODEL=true
```

Aliases (see `bot/StrategyRouter.js`): `deterministic`, `conservative`, `momentum`, `microstructure` → mapped ids above.

### `microstructure_edge` pipeline (brief)

1. **Binance aggTrade WebSocket** ingests taker-side volume, price, and quantity into [`signals/microstructure.js`](signals/microstructure.js).
2. Rolling 60s signals: **OFI** (order-flow imbalance proxy), **aggressor ratio**, **momentum**, **realized vol**.
3. [`signals/btcUpModel.js`](signals/btcUpModel.js) scores signals → **P(up)** (threshold ensemble + logistic squash, vol dampening toward 0.5).
4. Compare P(up) to Polymarket **YES midpoint** → **edge** = P(up) − YES.
5. Entry when `edge ≥ BOT_EDGE_THRESHOLD` (default 5pp), model is **ready** (≥5 trades in 60s window), and entry window / price band / Strategy Lab gates pass.
6. Optional **Strategy Lab gates** (spread, depth, slippage) can warn or block entries (`LAB_GATE_MODE`).

> **Important:** NATS price-only ticks do **not** carry aggTrade `m`/`q` fields. With `BOT_USE_NATS_FEEDS=true`, the bot opens a **direct aggTrade sidecar** for microstructure. For simplest setup, use direct mode (`NATS_URL=disabled`).

---

## Paper trading

- The bot **always** simulates fills at current midpoints; no CLOB orders are sent.
- Wallets persist under **`data/paper-wallets/`** — one JSON file per profile id (e.g. `default.json`, `conservative-25.json`).
- Named profiles: **`data/bot-profiles.json`**; session mirror: **`data/bot-profile.json`**.
- Cash adjustments (deposits/withdrawals) persist in **`data/cash-adjustments.json`** and are reflected on Portfolio.
- Active Strategy Lab preset: **`data/strategy-active-preset.json`** (read each market check, no restart needed).

**Typical workflow:**

1. `npm run dashboard` (or `npm run dev`)
2. Open **http://localhost:3847/bot**
3. Select profile (e.g. **Conservative 25%**), configure strategy and run duration
4. Click **Start bot with profile** — logs and bankroll update over WebSocket
5. View positions on **http://localhost:3847/portfolio**
6. Click **Stop** to SIGTERM the bot process

---

## Troubleshooting

### Bot inactive / no entries

- Confirm the bot is **running** on `/bot` (status shows active PID) or via `npm run dev` / `npm run paper:live`.
- Check bot logs for **`[EntrySkip]`** lines — common reasons:
  - **Outside entry window** — e.g. `need 30–270s after market start (currently 12s after start)`; wait until the window opens.
  - **Strategy not eligible** — YES below threshold, momentum not up, or P(up) edge below `BOT_EDGE_THRESHOLD`.
  - **Microstructure cold start** — model needs ≥5 aggTrades in 60s (`ready=false`).
  - **Microstructure gate** — spread/depth/slippage failed (`LAB_GATE_MODE=block`).
  - **Zero sizing** — bankroll is $0 or sizing config yields $0 bet.
- Ensure **`MARKET_WINDOW`** / bot window filter includes an active market type (5m windows expire quickly).

### Wrong market showing (e.g. World Cup / long-dated events)

- Gamma may return non-BTC or long-dated markets. The scanner blocklists titles matching `world cup`, `fifa`, `election`, etc. (`api/polymarket_runtime.js`).
- On **/live**, enable **Follow live window** to track the current BTC window instead of a stale pinned market.
- On **/markets**, pick the correct BTC 5m/15m/1d market; with Follow live **off**, that selection becomes primary.

### Brotli / JSON parse errors from Polymarket API

- Polymarket may return brotli-compressed bodies that break `res.json()` when using undici.
- The project sets **`Accept-Encoding: identity`** in [`lib/httpFetch.js`](lib/httpFetch.js) for Gamma/CLOB/Data API calls. If you see garbled JSON, ensure you have not removed that header path.

### NATS stack overflow or hang on startup

- Use **`NATS_URL=disabled`** and **`USE_NATS=false`** for dashboard-only direct mode.
- Set **`NATS_CONNECT_TIMEOUT_MS=8000`** so a dead broker does not hang forever.
- If NATS is enabled but no publisher runs, the header may show **Polymarket waiting (NATS, no ticks)** — start `npm run feeds:nats` or switch to direct mode.

### Port already in use (3847)

```bash
# Use another port
DASHBOARD_PORT=3848 npm run dashboard
```

### WebSocket disconnected

- Confirm the dashboard process is running on the same port as the browser URL.
- Check firewall/VPN blocking localhost WebSocket.

### Bot will not start (HTTP 409)

- A bot instance is already running or still stopping — use **Stop** on `/bot` or kill the child PID from status.

### No active BTC markets

- Short windows roll frequently; daily markets resolve once per day. Try **`all`** in the header selector or wait for the next window.

### Backtest: PolyBackTest unavailable

- The engine falls back to CLOB trade reconstruction automatically; runs may be slower.

---

## Project structure

```
polymarket_bot/
├── bot.js                 # Bot entry point
├── bot/                   # Config, session, scanner, strategy router, PolymarketBot
├── dashboard/             # HTTP server (server.js), static UI (public/), dev runners
├── api/                   # feeds_runtime.js (Binance/Chainlink), polymarket_runtime.js (Gamma/CLOB)
├── signals/               # Strategies, microstructure engine, btcUpModel, marketParams
├── backtest/              # CLI backtest engine
├── feeds/                 # Node NATS publisher (natsPublisher.js)
├── rust/feeds-rs/         # Optional Rust NATS publisher
├── lib/                   # HTTP fetch, sizing, NATS bridge, bot profiles, paper wallet
├── paper/                 # Paper portfolio math
├── risk/                  # Kelly sizing, liquidity gates
├── monitoring/            # Latency metrics + probes
├── data/                  # Presets, bot profiles, paper wallets (runtime state)
├── scripts/               # Doc checker, model smoke tests
├── docs/                  # MAINTENANCE.md, QUIET-STARTUP.md
├── docker-compose.yml     # NATS service definition
├── .env.example           # Environment template
└── package.json           # npm scripts
```

---

## Optional: low-latency stack

**Recommended for beginners:** stay in **quiet direct mode** — no Docker, no NATS, no Rust build.

When you want decoupled publishers and multiple consumers:

1. `npm run nats:up`
2. Set `NATS_URL=nats://127.0.0.1:4222`, `USE_NATS=true`, `USE_NATS_FEEDS=true`
3. Run **`npm run feeds:nats`** or **`npm run feeds:rust`** (after build)
4. Start **`npm run dashboard:nats`** or **`npm run dev:nats`**

NATS subjects (see `lib/nats/subjects.js`): `feeds.binance.price`, `feeds.polymarket.price`, `feeds.polymarket.orderbook`, `feeds.polymarket.trades`, `feeds.polymarket.markets`, `bot.status`, `bot.events`, `bot.control`.

If NATS feeds go idle, the dashboard automatically falls back to direct Binance/CLOB ingest after `NATS_FEED_FALLBACK_MS`.

---

## Further reading

- **In-app docs:** http://localhost:3847/docs
- **Doc maintenance checklist:** [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md)
- **Quiet startup template:** [`docs/QUIET-STARTUP.md`](docs/QUIET-STARTUP.md)
- **Rust feeds:** [`rust/feeds-rs/README.md`](rust/feeds-rs/README.md)

Verify docs stay in sync after script changes:

```bash
npm run check:docs
```
