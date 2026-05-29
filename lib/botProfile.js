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
  return {
    stopLossPct: parseOptionalFloat(env.BOT_STOP_LOSS_PCT),
    stopLossPrice: parseOptionalFloat(env.BOT_STOP_LOSS_PRICE),
    stopThreshold: Number(env.BOT_STOP_THRESHOLD || 0.45),
    entryMinSeconds: parseOptionalInt(env.BOT_ENTRY_MIN_SECONDS),
    entryMaxSeconds: parseOptionalInt(env.BOT_ENTRY_MAX_SECONDS),
    entryMinPrice: parseOptionalFloat(env.BOT_ENTRY_MIN_PRICE),
    entryMaxPrice: parseOptionalFloat(env.BOT_ENTRY_MAX_PRICE),
    maxTradesPerMarket: Math.max(1, parseOptionalInt(env.BOT_MAX_TRADES_PER_MARKET) ?? 1),
  };
}

function defaultBotProfile(env = process.env) {
  const session = defaultBotSessionConfig(env);
  return {
    strategyId: normalizeStrategyId(env.BOT_STRATEGY || 'deterministic_yes_50'),
    marketWindow: session.marketWindow,
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
  }
  if (input.marketWindow != null) {
    merged.marketWindow = normalizePolyMode(input.marketWindow);
  }
  if (input.runLimit != null) {
    merged.runLimit = normalizeRunLimit(input.runLimit);
  }

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
  if ('maxTradesPerMarket' in input) {
    const v = parseOptionalInt(input.maxTradesPerMarket);
    merged.maxTradesPerMarket = v != null && v > 0 ? Math.min(100, v) : 1;
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
    ...botConfigToEnv({ marketWindow: p.marketWindow, runLimit: p.runLimit }),
    BOT_STRATEGY: p.strategyId,
    BOT_STOP_THRESHOLD: String(p.stopThreshold),
    BOT_MAX_TRADES_PER_MARKET: String(p.maxTradesPerMarket),
  };
  if (p.stopLossPct != null) env.BOT_STOP_LOSS_PCT = String(p.stopLossPct);
  if (p.stopLossPrice != null) env.BOT_STOP_LOSS_PRICE = String(p.stopLossPrice);
  if (p.entryMinSeconds != null) env.BOT_ENTRY_MIN_SECONDS = String(p.entryMinSeconds);
  if (p.entryMaxSeconds != null) env.BOT_ENTRY_MAX_SECONDS = String(p.entryMaxSeconds);
  if (p.entryMinPrice != null) env.BOT_ENTRY_MIN_PRICE = String(p.entryMinPrice);
  if (p.entryMaxPrice != null) env.BOT_ENTRY_MAX_PRICE = String(p.entryMaxPrice);
  return env;
}

/**
 * Absolute YES stop floor for a long position (exit when price <= threshold).
 */
function resolveStopThreshold(entryPrice, profile = {}, signalStop) {
  const floors = [];
  if (Number.isFinite(profile.stopLossPrice) && profile.stopLossPrice > 0) {
    floors.push(profile.stopLossPrice);
  }
  if (Number.isFinite(profile.stopLossPct) && profile.stopLossPct > 0 && Number.isFinite(entryPrice)) {
    floors.push(entryPrice * (1 - profile.stopLossPct / 100));
  }
  if (Number.isFinite(signalStop) && signalStop > 0) floors.push(signalStop);
  const fallback = Number.isFinite(profile.stopThreshold) ? profile.stopThreshold : 0.45;
  floors.push(fallback);
  return floors.length ? Math.max(...floors) : fallback;
}

/**
 * Entry timing + optional YES price band.
 * @param {object} market
 * @param {number} timeRemainingSec
 * @param {object} [rules]
 */
function isWithinEntryWindow(market, timeRemainingSec, rules = {}) {
  const wm = market.windowMinutes;
  const total = WINDOW_TOTAL_SEC[wm];
  if (!total) return false;

  let maxRemaining;
  let minRemaining;

  if (Number.isFinite(rules.entryMaxSeconds)) {
    maxRemaining = rules.entryMaxSeconds;
  } else if (wm === 5) {
    maxRemaining = 270;
  } else if (wm === 15) {
    maxRemaining = 840;
  } else if (wm === 1440) {
    maxRemaining = 82800;
  } else {
    maxRemaining = total;
  }

  if (Number.isFinite(rules.entryMinSeconds)) {
    // 0 = no post-open delay (minRemaining 0); N>0 = need at least N seconds elapsed.
    minRemaining = rules.entryMinSeconds === 0 ? 0 : total - rules.entryMinSeconds;
  } else if (wm === 5) {
    minRemaining = 30;
  } else if (wm === 15) {
    minRemaining = 60;
  } else if (wm === 1440) {
    minRemaining = 3600;
  } else {
    minRemaining = 0;
  }

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

function entryWindowLabel(rules = {}) {
  const parts = [];
  if (Number.isFinite(rules.entryMinSeconds)) {
    parts.push(`≥${rules.entryMinSeconds}s after open`);
  }
  if (Number.isFinite(rules.entryMaxSeconds)) {
    parts.push(`≤${rules.entryMaxSeconds}s before end`);
  }
  if (Number.isFinite(rules.entryMinPrice)) {
    parts.push(`YES ≥ ${rules.entryMinPrice}`);
  }
  if (Number.isFinite(rules.entryMaxPrice)) {
    parts.push(`YES ≤ ${rules.entryMaxPrice}`);
  }
  return parts.length ? parts.join(' · ') : 'window defaults';
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
  isWithinEntryWindow,
  passesEntryPriceBand,
  entryWindowLabel,
};
