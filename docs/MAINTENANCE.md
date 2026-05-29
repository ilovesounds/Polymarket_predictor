# Documentation maintenance

This project ships user-facing docs at **`http://localhost:<DASHBOARD_PORT>/docs`** (default port `3847`). The HTML source lives in the dashboard static tree so it is served with the same theme and nav as the UI.

## Repository layout

| Path | Role |
|------|------|
| `bot.js` | Bot entry (`node bot.js` / `npm run paper:live`) |
| `bot/` | Config, session, scanner, strategy router, `PolymarketBot` |
| `dashboard/` | HTTP server, Strategy Lab API, static UI (`public/`) |
| `api/` | `feeds_runtime.js` (Binance/Chainlink), `polymarket_runtime.js` (Gamma/CLOB) |
| `signals/` | Strategies (`strategies_runtime.js`), microstructure (`marketParams.js`), edge cases |
| `paper/` | Paper portfolio state |
| `lib/` | HTTP fetch, sizing, market selection, NATS bridge, Strategy Lab presets |
| `risk/` | Kelly sizing (`manager_runtime.js`; `manager.js` is reference/docs) |
| `backtest/` | CLI backtest engine |
| `feeds/` | Node NATS publisher (`npm run feeds:nats`); optional Rust publisher (`npm run feeds:rust` after `feeds:rust:build`) |
| `monitoring/` | Latency metrics + trade-depth watch |
| `data/` | Strategy Lab presets, bot profiles, per-profile paper wallets |
| `docs/` | This maintenance checklist (user docs are under `dashboard/public/docs/`) |

## When to update docs

Update documentation in the **same PR or commit** as the code change when you:

| Change type | What to update |
|-------------|----------------|
| New/changed/removed `package.json` script | `dashboard/public/docs/index.html` → **npm scripts** table; run `npm run check:docs` |
| New/changed/removed env var in code | `.env.example` + docs **Environment variables** section |
| New dashboard route or page | `dashboard/server.js` `PAGE_ROUTES`, new HTML under `dashboard/public/`, nav links on **all** pages, docs **Dashboard pages** |
| Strategy Lab params, presets, or gate behavior | `signals/marketParams.js`, `lib/strategyLab.js`, `dashboard/labParams.js`, docs **Strategy Lab** section |
| New/changed strategy | `signals/strategies_runtime.js` + docs **Strategies** table + Bot page behavior if applicable |
| NATS subject or feed behavior | `lib/nats/subjects.js`, `rust/feeds-rs/README.md`, docs **NATS vs direct** |
| Backtest CLI flags or defaults | `backtest/engine.js` header comment + docs **Backtest** section |
| Bet sizing modes or profile storage | `lib/betSizing.js`, `lib/botProfilesStore.js`, `lib/paperWallet.js`, Bot + Lab UI, docs **Bet sizing** + **Named bot profiles** |
| API endpoint (`/api/...`) | `dashboard/server.js` + docs **HTTP API** list |
| Bot market filter / run limits | `lib/botRunConfig.js`, `bot/SessionManager.js`, `bot.js`, Bot page UI, `.env.example` |
| Bot architecture / strategies / exit mode | `bot/Config.js`, `bot/MarketScanner.js`, `bot/StrategyRouter.js`, `bot/PolymarketBot.js`, `signals/strategies_runtime.js`, `.env.example` |
| Troubleshooting for a recurring issue | docs **Troubleshooting** section (one short symptom → fix) |

If the change is internal-only (refactor, rename private helper) with no user-visible behavior, docs do not need an update.

## Bot module layout (`bot/`)

| Module | Role |
|--------|------|
| `bot/Config.js` | Central env: windows, strategies, NATS, session, polling |
| `bot/SessionManager.js` | `BOT_SESSION_MODE`: indefinite, timed, trades, pnl |
| `bot/MarketScanner.js` | Gamma roster + CLOB enrich (mid, book, spread, ring-buffer history) |
| `bot/StrategyRouter.js` | `BOT_STRATEGIES` priority list → `signals/strategies_runtime.js` |
| `bot/PolymarketBot.js` | WS-driven eval (default) + 30s discovery tick; paper execute |
| `lib/priceRingBuffer.js` | Per-market YES + BTC ring buffers (`BOT_PRICE_BUFFER_SIZE`) |
| `lib/httpFetch.js` | Keep-alive `fetch` for Gamma/CLOB/Data API |
| `bot.js` | Entry point only (`node bot.js`) |

Execution stays paper-only (hard lock). Live CLOB orders are not wired from `bot/`.

### Exit behavior

| Env | Behavior |
|-----|----------|
| *(unset target)* | `resolve_only` — hold YES until Gamma reports outcome; settle at $1 (YES wins) or $0 |
| `BOT_EXIT_TARGET_PRICE` or `BOT_TAKE_PROFIT_PRICE` | `fixed_price` — paper-sell when midpoint ≥ target |
| `BOT_EXIT_MODE` | Force `resolve_only` or `fixed_price` (target required for fixed) |
| `BOT_STOP_THRESHOLD` | Stop-loss still applies before take-profit / resolution |

Entry skips when strategy passes but execution does not: look for `[EntrySkip]` (sizing $0, microstructure gate, etc.).

### Latency / feeds

| Env | Behavior |
|-----|----------|
| `BOT_USE_WS=true` (default) | CLOB WS price → ring buffer → debounced strategy eval; REST tick for discovery only |
| `BOT_USE_WS=false` | Legacy REST poll path (`BOT_POLL_INTERVAL_MS`) evaluates all tradable markets each tick |
| `BOT_WS_EVAL_THROTTLE_MS` | Debounce per market (default 250, same as dashboard `POLY_WS_THROTTLE_MS`) |
| `BOT_PRICE_BUFFER_SIZE` | Ring buffer depth for BTC + per-market YES mids |
| `BOT_GAMMA_CACHE_MS` | Gamma market list cache TTL (default 40s) |

Dashboard pushes bot/latency events over WebSocket (`/ws`) and SSE (`GET /api/events/stream`). Latency page uses SSE + one-shot REST bootstrap.

## Files to edit

| File | Purpose |
|------|---------|
| `dashboard/public/docs/index.html` | Main documentation content (sections, tables, commands) |
| `dashboard/public/docs/docs.css` | Docs layout/styles (rare) |
| `dashboard/public/*.html` | Add **Docs** nav link if you add a new top-level page |
| `dashboard/server.js` | `PAGE_ROUTES` for `/docs` and any new routes |
| `.env.example` | Canonical env template; keep in sync with docs tables |
| `docs/MAINTENANCE.md` | This checklist (meta changes only) |
| `rust/feeds-rs/README.md` | Rust-specific NATS/schema detail |

## Workflow (recommended)

1. Make the code change.
2. Update `index.html` (and `.env.example` if needed).
3. From project root:

   ```bash
   npm run check:docs
   ```

4. Manually skim `/docs` in the browser after `npm run dashboard`.
5. Mention doc updates in the PR description (“Updated /docs npm scripts and env vars”).

## Automated check

`scripts/check-docs-stale.js` compares `package.json` `scripts` keys to the npm scripts table in `dashboard/public/docs/index.html`. It prints missing or extra script names and exits with code `1` on mismatch.

It does **not** validate env vars or prose — those rely on review and `.env.example` parity.

## Optional CI

Add to CI or a pre-push hook:

```bash
npm run check:docs
```

## package.json note

The `check:docs` script is registered in `package.json`. When adding scripts, add a row to the docs table in the same change.
