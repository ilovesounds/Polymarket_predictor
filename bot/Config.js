/**
 * Centralized bot configuration from environment variables.
 */

const { modeToWindows, normalizePolyMode, polyModeToMarketWindow } = require('../lib/marketSelection');
const { getAllowedWindows } = require('../api/polymarket_runtime');
const { normalizeStrategyId } = require('../signals/strategies_runtime');
const { parseStrategyPriority } = require('./StrategyRouter');
const { resolvePortfolioCashFromAdjustments } = require('../lib/cashAdjustments');
const { isNatsEnabled, isChainlinkEnabled, resolvePolygonRpc } = require('../lib/serviceFlags');

/**
 * Exit: fixed take-profit price vs hold for resolution payout.
 * Default resolve_only when BOT_EXIT_TARGET_PRICE / BOT_TAKE_PROFIT_PRICE unset.
 */
function resolveExitConfig(env = process.env) {
  const rawTarget = env.BOT_EXIT_TARGET_PRICE || env.BOT_TAKE_PROFIT_PRICE || '';
  const parsedTarget = parseFloat(rawTarget);
  const hasTarget = Number.isFinite(parsedTarget) && parsedTarget > 0 && parsedTarget <= 1;

  const modeRaw = String(env.BOT_EXIT_MODE || '').trim().toLowerCase();
  let exitMode;
  if (modeRaw === 'fixed_price' || modeRaw === 'take_profit') {
    exitMode = hasTarget ? 'fixed_price' : 'resolve_only';
    if (!hasTarget) {
      console.warn('[Config] BOT_EXIT_MODE=fixed_price but no BOT_EXIT_TARGET_PRICE — using resolve_only');
    }
  } else if (modeRaw === 'resolve_only' || modeRaw === 'resolution') {
    exitMode = 'resolve_only';
  } else {
    exitMode = hasTarget ? 'fixed_price' : 'resolve_only';
  }

  return {
    exitMode,
    exitTargetPrice: exitMode === 'fixed_price' ? parsedTarget : null,
  };
}

function loadConfig(env = process.env) {
  const paperTrade = true; // hard-enforced safety mode
  if (env.PAPER_TRADE === 'false') {
    console.warn('[Safety] PAPER_TRADE=false ignored. Bot is hard-locked to PAPER mode.');
  }

  const marketMode = normalizePolyMode(
    env.BOT_MARKET_WINDOW || env.DASHBOARD_POLY_MODE || env.MARKET_WINDOW || 'all'
  );
  const allowedWindows = modeToWindows(marketMode);
  // Keep polymarket_runtime window filter in sync when spawned from dashboard
  if (!env.MARKET_WINDOW && env.BOT_MARKET_WINDOW) {
    process.env.MARKET_WINDOW = polyModeToMarketWindow(marketMode);
  }

  const strategyIds = parseStrategyPriority(env);
  const legacyStrategy = normalizeStrategyId(env.BOT_STRATEGY || 'deterministic_yes_50');
  const resolvedStrategyIds = strategyIds.length ? strategyIds : [legacyStrategy];
  const useMicrostructureModel = env.BOT_USE_MICROSTRUCTURE_MODEL !== 'false'
    || resolvedStrategyIds.includes('microstructure_edge');
  const exitConfig = resolveExitConfig(env);
  const envStartingCash = parseFloat(env.STARTING_CASH || env.STARTING_BANKROLL || '20');
  const profileId = env.BOT_PROFILE_ID || env.PAPER_WALLET_PROFILE || null;
  let cashFromFile;
  if (profileId) {
    const { loadPaperWallet } = require('../lib/paperWallet');
    const wallet = loadPaperWallet(profileId, envStartingCash);
    cashFromFile = {
      cash: wallet.cash,
      startingCash: wallet.startingCash,
      netCashDelta: wallet.netCashDelta ?? 0,
    };
  } else {
    cashFromFile = resolvePortfolioCashFromAdjustments(envStartingCash);
  }

  const parseOptFloat = (raw) => {
    if (raw == null || raw === '') return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  };
  const parseOptInt = (raw) => {
    if (raw == null || raw === '') return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  };

  return {
    paperTrade,
    privateKey: env.PRIVATE_KEY || null,
    polygonRpc: resolvePolygonRpc(env),
    chainlinkEnabled: isChainlinkEnabled(env),
    pollIntervalMs: Number(env.BOT_POLL_INTERVAL_MS || 30_000),
    positionValuationMs: Number(env.POSITION_VALUATION_MS || 10_000),
    stopThreshold: Number(env.BOT_STOP_THRESHOLD || 0.45),
    stopLossPct: parseOptFloat(env.BOT_STOP_LOSS_PCT),
    stopLossPrice: parseOptFloat(env.BOT_STOP_LOSS_PRICE),
    entryMinSeconds: parseOptInt(env.BOT_ENTRY_MIN_SECONDS),
    entryMaxSeconds: parseOptInt(env.BOT_ENTRY_MAX_SECONDS),
    entryMinPrice: parseOptFloat(env.BOT_ENTRY_MIN_PRICE),
    entryMaxPrice: parseOptFloat(env.BOT_ENTRY_MAX_PRICE),
    tradesPerMarket: env.BOT_TRADES_PER_MARKET === 'multiple' ? 'multiple' : 'single',
    maxTradesPerMarket: Math.max(1, parseOptInt(env.BOT_MAX_TRADES_PER_MARKET) ?? 1),
    minSecondsBetweenEntries: Math.max(0, parseOptInt(env.BOT_MIN_SECONDS_BETWEEN_ENTRIES) ?? 0),
    multiEntryMode: env.BOT_MULTI_ENTRY_MODE === 'simultaneous' ? 'simultaneous' : 'sequential',
    envStartingCash,
    startingCash: cashFromFile.startingCash,
    initialCash: cashFromFile.cash,
    netCashDelta: cashFromFile.netCashDelta,
    marketMode,
    allowedWindows: allowedWindows.length ? allowedWindows : getAllowedWindows(),
    strategyIds: resolvedStrategyIds,
    legacyStrategyId: legacyStrategy,
    useNats: isNatsEnabled(env),
    botUseNatsFeeds: isNatsEnabled(env) && env.BOT_USE_NATS_FEEDS === 'true',
    sessionMode: env.BOT_SESSION_MODE || env.SESSION_MODE || null,
    sessionPnlStop: parseFloat(env.BOT_SESSION_PNL_STOP || env.SESSION_PNL_STOP || ''),
    sessionPnlTarget: parseFloat(env.BOT_SESSION_PNL_TARGET || env.SESSION_PNL_TARGET || ''),
    runMode: env.BOT_RUN_MODE || null,
    runMarketLimit: parseOptInt(env.BOT_RUN_MARKET_LIMIT),
    runTimeLimitMinutes: parseOptInt(env.BOT_RUN_TIME_LIMIT_MINUTES),
    runUntil: env.BOT_RUN_UNTIL || null,
    runLimitMode: env.BOT_RUN_LIMIT_MODE,
    runLimitTrades: env.BOT_RUN_LIMIT_TRADES,
    enrichPriceHistory: env.BOT_ENRICH_PRICE_HISTORY === 'true',
    priceHistoryHours: Number(env.BOT_PRICE_HISTORY_HOURS || 1),
    useWsEval: env.BOT_USE_WS !== 'false',
    wsEvalThrottleMs: Number(env.BOT_WS_EVAL_THROTTLE_MS || env.POLY_WS_THROTTLE_MS || 250),
    priceBufferSize: Number(env.BOT_PRICE_BUFFER_SIZE || 50),
    gammaCacheMs: Number(env.BOT_GAMMA_CACHE_MS || env.GAMMA_CACHE_MS || 40_000),
    exitMode: exitConfig.exitMode,
    exitTargetPrice: exitConfig.exitTargetPrice,
    profileId: profileId || null,
    edgeThreshold: Math.max(0, parseFloat(env.BOT_EDGE_THRESHOLD || '0.05') || 0.05),
    useMicrostructureModel,
  };
}

module.exports = { loadConfig, resolveExitConfig };
