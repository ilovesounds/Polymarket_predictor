/**
 * Unified bot profile: strategy, session window/limit, stop-loss, entry timing, per-market caps.
 * Shared by dashboard (Strategy Lab + Bot page) and bot subprocess env.
 */
const fs = require('fs');
const path = require('path');
const { normalizePolyMode } = require('./marketSelection');
const { isRedisRequested } = require('./redis');
const { getBotProfileFromRedis, setBotProfileInRedis } = require('./redisProfileStore');
const { normalizeStrategyId } = require('../signals/strategies_runtime');
const {
  normalizeRunLimit,
  normalizeRunDuration,
  runLimitFromRunDuration,
  defaultBotSessionConfig,
  botConfigToEnv,
} = require('./botRunConfig');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BOT_PROFILE_FILE = path.join(DATA_DIR, 'bot-profile.json');

const WINDOW_TOTAL_SEC = { 5: 300, 15: 900, 1440: 86400 };

function parseOptionalFloat(raw) {
  if (raw == null || raw === '') return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function parseOptionalInt(raw) {
  if (raw == null || raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function defaultTradingControls(env = process.env) {
  const takeRaw = env.BOT_TAKE_PROFIT_PRICE || env.BOT_EXIT_TARGET_PRICE || '';
  const takeProfitPrice = parseOptionalFloat(takeRaw);
  return {
    stopLossPct: parseOptionalFloat(env.BOT_STOP_LOSS_PCT),
    stopLossPrice: parseOptionalFloat(env.BOT_STOP_LOSS_PRICE),
    stopThreshold: Number(env.BOT_STOP_THRESHOLD || 0.45),
    takeProfitPrice: takeProfitPrice != null && takeProfitPrice > 0 && takeProfitPrice <= 1
      ? takeProfitPrice
      : null,
    entryMinSeconds: parseOptionalInt(env.BOT_ENTRY_MIN_SECONDS),
    entryMaxSeconds: parseOptionalInt(env.BOT_ENTRY_MAX_SECONDS),
    entryMinPrice: parseOptionalFloat(env.BOT_ENTRY_MIN_PRICE),
    entryMaxPrice: parseOptionalFloat(env.BOT_ENTRY_MAX_PRICE),
    tradesPerMarket: env.BOT_TRADES_PER_MARKET === 'multiple' ? 'multiple' : 'single',
    maxTradesPerMarket: Math.max(1, parseOptionalInt(env.BOT_MAX_TRADES_PER_MARKET) ?? 1),
    minSecondsBetweenEntries: Math.max(0, parseOptionalInt(env.BOT_MIN_SECONDS_BETWEEN_ENTRIES) ?? 0),
    multiEntryMode: env.BOT_MULTI_ENTRY_MODE === 'simultaneous' ? 'simultaneous' : 'sequential',
    edgeThreshold: Math.max(0, parseOptionalFloat(env.BOT_EDGE_THRESHOLD) ?? 0.05),
    useMicrostructureModel: env.BOT_USE_MICROSTRUCTURE_MODEL !== 'false',
  };
}

function defaultBotProfile(env = process.env) {
  const session = defaultBotSessionConfig(env);
  return {
    strategyId: normalizeStrategyId(env.BOT_STRATEGY || 'deterministic_yes_50'),
    marketWindow: session.marketWindow,
    runMode: session.runDuration.runMode,
    runMarketLimit: session.runDuration.runMarketLimit,
    runTimeLimitMinutes: session.runDuration.runTimeLimitMinutes,
    runUntil: session.runDuration.runUntil,
    runLimit: session.runLimit,
    ...defaultTradingControls(env),
    updatedAt: null,
  };
}

/**
 * @param {object} input
 * @param {object} [base]
 */
function normalizeBotProfile(input = {}, base = null) {
  const seed = base || defaultBotProfile();
  const merged = { ...seed, ...input };

  if (input.strategyId != null) {
    merged.strategyId = normalizeStrategyId(input.strategyId);
    if (merged.strategyId === 'microstructure_edge' && input.useMicrostructureModel !== false) {
      merged.useMicrostructureModel = true;
    }
  }
  if ('edgeThreshold' in input) {
    const v = parseOptionalFloat(input.edgeThreshold);
    merged.edgeThreshold = v != null && v >= 0 ? v : seed.edgeThreshold;
  }
  if ('useMicrostructureModel' in input) {
    merged.useMicrostructureModel = input.useMicrostructureModel !== false;
  }
  if (input.marketWindow != null) {
    merged.marketWindow = normalizePolyMode(input.marketWindow);
  }
  if (input.runLimit != null) {
    merged.runLimit = normalizeRunLimit(input.runLimit);
  }
  if (input.runMode != null || input.runMarketLimit != null
    || input.runTimeLimitMinutes != null || input.runUntil != null) {
    merged.runDuration = normalizeRunDuration(input, merged.runLimit);
  } else if (input.runLimit != null) {
    merged.runDuration = normalizeRunDuration({}, merged.runLimit);
  } else if (!merged.runDuration) {
    merged.runDuration = normalizeRunDuration(merged, merged.runLimit);
  }
  merged.runMode = merged.runDuration.runMode;
  merged.runMarketLimit = merged.runDuration.runMarketLimit;
  merged.runTimeLimitMinutes = merged.runDuration.runTimeLimitMinutes;
  merged.runUntil = merged.runDuration.runUntil;
  merged.runLimit = runLimitFromRunDuration(merged.runDuration);

  if ('stopLossPct' in input) {
    const v = parseOptionalFloat(input.stopLossPct);
    merged.stopLossPct = v != null && v > 0 ? Math.min(99, v) : null;
  }
  if ('stopLossPrice' in input) {
    const v = parseOptionalFloat(input.stopLossPrice);
    merged.stopLossPrice = v != null && v > 0 && v <= 1 ? v : null;
  }
  if ('stopThreshold' in input) {
    const v = parseOptionalFloat(input.stopThreshold);
    merged.stopThreshold = v != null && v > 0 && v <= 1 ? v : seed.stopThreshold;
  }
  if ('takeProfitPrice' in input) {
    const v = parseOptionalFloat(input.takeProfitPrice);
    merged.takeProfitPrice = v != null && v > 0 && v <= 1 ? v : null;
  }
  if ('entryMinSeconds' in input) {
    const v = parseOptionalInt(input.entryMinSeconds);
    merged.entryMinSeconds = v != null && v >= 0 ? v : null;
  }
  if ('entryMaxSeconds' in input) {
    const v = parseOptionalInt(input.entryMaxSeconds);
    merged.entryMaxSeconds = v != null && v >= 0 ? v : null;
  }
  if ('entryMinPrice' in input) {
    const v = parseOptionalFloat(input.entryMinPrice);
    merged.entryMinPrice = v != null && v >= 0 && v <= 1 ? v : null;
  }
  if ('entryMaxPrice' in input) {
    const v = parseOptionalFloat(input.entryMaxPrice);
    merged.entryMaxPrice = v != null && v >= 0 && v <= 1 ? v : null;
  }
  if ('tradesPerMarket' in input) {
    merged.tradesPerMarket = input.tradesPerMarket === 'multiple' ? 'multiple' : 'single';
  }
  if ('maxTradesPerMarket' in input) {
    const v = parseOptionalInt(input.maxTradesPerMarket);
    merged.maxTradesPerMarket = v != null && v > 0 ? Math.min(5, v) : 1;
  }
  if ('minSecondsBetweenEntries' in input) {
    const v = parseOptionalInt(input.minSecondsBetweenEntries);
    merged.minSecondsBetweenEntries = v != null && v >= 0 ? Math.min(3600, v) : 0;
  }
  if ('multiEntryMode' in input) {
    merged.multiEntryMode = input.multiEntryMode === 'sequential' ? 'sequential' : 'simultaneous';
  } else if (!merged.multiEntryMode) {
    merged.multiEntryMode = 'sequential';
  }
  if (merged.tradesPerMarket === 'single') {
    merged.maxTradesPerMarket = 1;
    merged.minSecondsBetweenEntries = 0;
  } else if (merged.maxTradesPerMarket <= 1) {
    merged.maxTradesPerMarket = 2;
  }

  return merged;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadBotProfileFromFile(env = process.env) {
  try {
    if (fs.existsSync(BOT_PROFILE_FILE)) {
      const raw = fs.readFileSync(BOT_PROFILE_FILE, 'utf8');
      const stored = raw ? JSON.parse(raw) : null;
      if (stored && typeof stored === 'object') {
        return normalizeBotProfile(stored, defaultBotProfile(env));
      }
    }
  } catch (_) {}
  return defaultBotProfile(env);
}

function loadBotProfile(env = process.env) {
  return loadBotProfileFromFile(env);
}

/**
 * Prefer Redis when connected, then file, then env defaults.
 * @param {object} [env]
 * @returns {Promise<object>}
 */
async function loadBotProfileAsync(env = process.env) {
  if (isRedisRequested()) {
    try {
      const fromRedis = await getBotProfileFromRedis();
      if (fromRedis && typeof fromRedis === 'object') {
        const normalized = normalizeBotProfile(fromRedis, defaultBotProfile(env));
        writeBotProfileFile(normalized);
        return normalized;
      }
    } catch (_) {}
  }
  return loadBotProfileFromFile(env);
}

function writeBotProfileFile(profile) {
  ensureDataDir();
  fs.writeFileSync(BOT_PROFILE_FILE, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
}

function saveBotProfile(profile) {
  const normalized = normalizeBotProfile(profile);
  normalized.updatedAt = Date.now();
  writeBotProfileFile(normalized);
  if (isRedisRequested()) {
    setBotProfileInRedis(normalized).catch((err) => {
      console.warn('[BotProfile] Redis mirror failed:', err?.message || err);
    });
  }
  return normalized;
}

async function saveBotProfileAsync(profile) {
  const normalized = saveBotProfile(profile);
  if (isRedisRequested()) {
    await setBotProfileInRedis(normalized).catch(() => {});
  }
  return normalized;
}

function mergeBotProfile(partial, env = process.env) {
  const current = loadBotProfile(env);
  return saveBotProfile(normalizeBotProfile(partial, current));
}

/**
 * Env vars for bot.js child process from full profile.
 */
function profileToEnv(profile) {
  const p = normalizeBotProfile(profile);
  const env = {
    ...botConfigToEnv({
      marketWindow: p.marketWindow,
      runLimit: p.runLimit,
      runMode: p.runMode,
      runMarketLimit: p.runMarketLimit,
      runTimeLimitMinutes: p.runTimeLimitMinutes,
      runUntil: p.runUntil,
    }),
    BOT_STRATEGY: p.strategyId,
    BOT_STOP_THRESHOLD: String(p.stopThreshold),
    BOT_TRADES_PER_MARKET: p.tradesPerMarket === 'multiple' ? 'multiple' : 'single',
    BOT_MAX_TRADES_PER_MARKET: String(p.maxTradesPerMarket),
    BOT_MIN_SECONDS_BETWEEN_ENTRIES: String(p.minSecondsBetweenEntries ?? 0),
    BOT_MULTI_ENTRY_MODE: p.multiEntryMode === 'sequential' ? 'sequential' : 'simultaneous',
  };
  if (p.stopLossPct != null) env.BOT_STOP_LOSS_PCT = String(p.stopLossPct);
  if (p.stopLossPrice != null) env.BOT_STOP_LOSS_PRICE = String(p.stopLossPrice);
  if (p.entryMinSeconds != null) env.BOT_ENTRY_MIN_SECONDS = String(p.entryMinSeconds);
  if (p.entryMaxSeconds != null) env.BOT_ENTRY_MAX_SECONDS = String(p.entryMaxSeconds);
  if (p.entryMinPrice != null) env.BOT_ENTRY_MIN_PRICE = String(p.entryMinPrice);
  if (p.entryMaxPrice != null) env.BOT_ENTRY_MAX_PRICE = String(p.entryMaxPrice);
  if (p.takeProfitPrice != null) env.BOT_TAKE_PROFIT_PRICE = String(p.takeProfitPrice);
  if (p.edgeThreshold != null) env.BOT_EDGE_THRESHOLD = String(p.edgeThreshold);
  if (normalizeStrategyId(p.strategyId) === 'microstructure_edge') {
    env.BOT_USE_MICROSTRUCTURE_MODEL = 'true';
  } else if (p.useMicrostructureModel === false) {
    env.BOT_USE_MICROSTRUCTURE_MODEL = 'false';
  }
  return env;
}

/**
 * Absolute YES stop floor for a long position (exit when price <= threshold).
 */
function resolveStopThreshold(entryPrice, profile = {}, signalStop) {
  const floors = [];
  const hasProfileStop = Number.isFinite(profile.stopLossPrice) && profile.stopLossPrice > 0
    || Number.isFinite(profile.stopLossPct) && profile.stopLossPct > 0;
  if (Number.isFinite(profile.stopLossPrice) && profile.stopLossPrice > 0) {
    floors.push(profile.stopLossPrice);
  }
  if (Number.isFinite(profile.stopLossPct) && profile.stopLossPct > 0 && Number.isFinite(entryPrice)) {
    floors.push(entryPrice * (1 - profile.stopLossPct / 100));
  }
  if (floors.length) return Math.max(...floors);
  if (Number.isFinite(signalStop) && signalStop > 0) return signalStop;
  return Number.isFinite(profile.stopThreshold) ? profile.stopThreshold : 0.45;
}

/** Effective min/max time-remaining (seconds) for entry on a window. */
function resolveEntryWindowBounds(windowMinutes, rules = {}) {
  const total = WINDOW_TOTAL_SEC[windowMinutes];
  if (!total) return { minRemaining: 0, maxRemaining: 0, total: 0 };

  let maxRemaining;
  if (Number.isFinite(rules.entryMaxSeconds)) {
    maxRemaining = rules.entryMaxSeconds;
  } else if (windowMinutes === 5) {
    maxRemaining = 270;
  } else if (windowMinutes === 15) {
    maxRemaining = 840;
  } else if (windowMinutes === 1440) {
    maxRemaining = 82800;
  } else {
    maxRemaining = total;
  }

  let minRemaining;
  if (Number.isFinite(rules.entryMinSeconds)) {
    // N>0: latest entry at N seconds after start (minRemaining = total - N). N=0: no cutoff before close.
    minRemaining = rules.entryMinSeconds === 0 ? 0 : total - rules.entryMinSeconds;
  } else if (windowMinutes === 5) {
    minRemaining = 30;
  } else if (windowMinutes === 15) {
    minRemaining = 60;
  } else if (windowMinutes === 1440) {
    minRemaining = 3600;
  } else {
    minRemaining = 0;
  }

  return { minRemaining, maxRemaining, total };
}

/** Seconds elapsed since window open from time remaining. */
function elapsedAfterMarketStart(windowMinutes, timeRemainingSec) {
  const total = WINDOW_TOTAL_SEC[windowMinutes];
  if (!total) return null;
  return Math.max(0, Math.round(total - timeRemainingSec));
}

/** Entry band as earliest/latest seconds after market start (for labels and logs). */
function entryWindowAfterStartBounds(windowMinutes, rules = {}) {
  const { minRemaining, maxRemaining, total } = resolveEntryWindowBounds(windowMinutes, rules);
  if (!total) return { earliestAfterStart: 0, latestAfterStart: 0, total: 0 };
  return {
    earliestAfterStart: total - maxRemaining,
    latestAfterStart: total - minRemaining,
    total,
  };
}

function formatEntryWindowBand(windowMinutes, rules = {}) {
  const { earliestAfterStart, latestAfterStart, total } = entryWindowAfterStartBounds(windowMinutes, rules);
  if (!total) return 'unknown window';
  return `${earliestAfterStart}–${latestAfterStart}s after market start`;
}

/**
 * Entry timing + optional YES price band.
 * @param {object} market
 * @param {number} timeRemainingSec
 * @param {object} [rules]
 */
function isWithinEntryWindow(market, timeRemainingSec, rules = {}) {
  const { minRemaining, maxRemaining, total } = resolveEntryWindowBounds(market.windowMinutes, rules);
  if (!total) return false;
  if (timeRemainingSec > maxRemaining || timeRemainingSec < minRemaining) {
    return false;
  }
  return true;
}

function passesEntryPriceBand(yesPrice, rules = {}) {
  if (Number.isFinite(rules.entryMinPrice) && yesPrice < rules.entryMinPrice) return false;
  if (Number.isFinite(rules.entryMaxPrice) && yesPrice > rules.entryMaxPrice) return false;
  return true;
}

function entryWindowLabel(rules = {}, windowMinutes = 5) {
  const parts = [formatEntryWindowBand(windowMinutes, rules)];
  if (Number.isFinite(rules.entryMinPrice)) {
    parts.push(`YES ≥ ${rules.entryMinPrice}`);
  }
  if (Number.isFinite(rules.entryMaxPrice)) {
    parts.push(`YES ≤ ${rules.entryMaxPrice}`);
  }
  return parts.join(' · ');
}

function entryWindowPreview(rules = {}, windowMinutes = 5) {
  return `Entry window: ${formatEntryWindowBand(windowMinutes, rules)}`;
}

function stopLossPreview(profile = {}, entryPrice = 0.5, strategyStop = null) {
  const stop = resolveStopThreshold(entryPrice, profile, strategyStop);
  const parts = [`Stop loss: YES ≤ ${stop.toFixed(2)}`];
  if (Number.isFinite(profile.stopLossPrice)) {
    parts.push(`(floor ${profile.stopLossPrice})`);
  } else if (Number.isFinite(profile.stopLossPct)) {
    parts.push(`(${profile.stopLossPct}% from entry)`);
  }
  if (Number.isFinite(profile.takeProfitPrice)) {
    parts.push(`· Take profit: YES ≥ ${profile.takeProfitPrice}`);
  }
  return parts.join(' ');
}

function tradingControlsPreview(profile = {}, windowMinutes = 5, strategyStop = null) {
  const rules = {
    entryMinSeconds: profile.entryMinSeconds,
    entryMaxSeconds: profile.entryMaxSeconds,
    entryMinPrice: profile.entryMinPrice,
    entryMaxPrice: profile.entryMaxPrice,
  };
  return {
    entryWindow: entryWindowPreview(rules, windowMinutes),
    stopLoss: stopLossPreview(profile, 0.5, strategyStop),
  };
}

module.exports = {
  BOT_PROFILE_FILE,
  WINDOW_TOTAL_SEC,
  defaultBotProfile,
  normalizeBotProfile,
  loadBotProfile,
  loadBotProfileFromFile,
  loadBotProfileAsync,
  saveBotProfile,
  saveBotProfileAsync,
  mergeBotProfile,
  profileToEnv,
  resolveStopThreshold,
  resolveEntryWindowBounds,
  elapsedAfterMarketStart,
  entryWindowAfterStartBounds,
  formatEntryWindowBand,
  isWithinEntryWindow,
  passesEntryPriceBand,
  entryWindowLabel,
  entryWindowPreview,
  stopLossPreview,
  tradingControlsPreview,
};
