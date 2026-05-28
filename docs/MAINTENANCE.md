# Documentation maintenance

This project ships user-facing docs at **`http://localhost:<DASHBOARD_PORT>/docs`** (default port `3847`). The HTML source lives in the dashboard static tree so it is served with the same theme and nav as the UI.

## When to update docs

Update documentation in the **same PR or commit** as the code change when you:

| Change type | What to update |
|-------------|----------------|
| New/changed/removed `package.json` script | `dashboard/public/docs/index.html` → **npm scripts** table; run `npm run check:docs` |
| New/changed/removed env var in code | `.env.example` + docs **Environment variables** section |
| New dashboard route or page | `dashboard/server.js` `PAGE_ROUTES`, new HTML under `dashboard/public/`, nav links on **all** pages, docs **Dashboard pages** |
| New/changed strategy | `signals/strategies_runtime.js` + docs **Strategies** table + Bot page behavior if applicable |
| NATS subject or feed behavior | `lib/nats/subjects.js`, `rust/feeds-rs/README.md`, docs **NATS vs direct** |
| Backtest CLI flags or defaults | `backtest/engine.js` header comment + docs **Backtest** section |
| API endpoint (`/api/...`) | `dashboard/server.js` + docs **HTTP API** list |
| Troubleshooting for a recurring issue | docs **Troubleshooting** section (one short symptom → fix) |

If the change is internal-only (refactor, rename private helper) with no user-visible behavior, docs do not need an update.

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
