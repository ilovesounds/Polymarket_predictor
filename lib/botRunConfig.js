/**
 * Bot session config: which market windows to trade and optional run limits.
 */

const { normalizePolyMode, polyModeToMarketWindow } = require('./marketSelection');

const RUN_LIMIT_MODES = new Set(['unlimited', 'trades', 'end_of_day', 'pnl']);

function parseRunLimitMode(raw) {
  const v = String(raw || 'unlimited').trim().toLowerCase();
  if (v === 'trades' || v === 'trade_count' || v === 'count') return 'trades';
  if (v === 'end_of_day' || v === 'eod' || v === 'day' || v === 'timed') return 'end_of_day';
  if (v === 'pnl' || v === 'profit' || v === 'loss') return 'pnl';
  if (v === 'indefinite' || v === 'unlimited' || v === 'forever') return 'unlimited';
  return 'unlimited';
}

/**
 * @param {string|{ mode?: string, tradeCount?: number }} input
 * @returns {{ mode: 'unlimited'|'trades'|'end_of_day', tradeCount: number|null }}
 */
function normalizeRunLimit(input) {
  if (!input || input === 'unlimited') {
    return { mode: 'unlimited', tradeCount: null };
  }
  if (typeof input === 'string') {
    const preset = input.trim().toLowerCase();
    if (preset === 'unlimited') return { mode: 'unlimited', tradeCount: null };
    if (preset === 'end_of_day' || preset === 'eod' || preset === 'day') {
      return { mode: 'end_of_day', tradeCount: null };
    }
    const tradesMatch = preset.match(/^trades[_:-]?(\d+)$/);
    if (tradesMatch) {
      const n = Math.max(1, parseInt(tradesMatch[1], 10));
      return { mode: 'trades', tradeCount: n };
    }
  }
  if (typeof input === 'object') {
    const mode = parseRunLimitMode(input.mode);
    if (mode === 'end_of_day') return { mode: 'end_of_day', tradeCount: null };
    if (mode === 'pnl') return { mode: 'pnl', tradeCount: null };
    if (mode === 'trades') {
      const n = Number(input.tradeCount);
      const tradeCount = Number.isFinite(n) && n > 0 ? Math.floor(n) : 11;
      return { mode: 'trades', tradeCount };
    }
  }
  return { mode: 'unlimited', tradeCount: null };
}

function defaultBotSessionConfig(env = process.env) {
  const marketWindow = normalizePolyMode(
    env.BOT_MARKET_WINDOW || env.DASHBOARD_POLY_MODE || env.MARKET_WINDOW || '15m'
  );
  const mode = parseRunLimitMode(env.BOT_RUN_LIMIT_MODE);
  const parsedCount = parseInt(env.BOT_RUN_LIMIT_TRADES || '', 10);
  const tradeCount = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 11;
  const runLimit = mode === 'trades'
    ? { mode: 'trades', tradeCount }
    : mode === 'end_of_day'
      ? { mode: 'end_of_day', tradeCount: null }
      : { mode: 'unlimited', tradeCount: null };
  return { marketWindow, runLimit };
}

/**
 * Env vars passed to bot.js child process.
 * @param {{ marketWindow: string, runLimit: { mode: string, tradeCount: number|null } }} config
 */
function botConfigToEnv(config) {
  const marketWindow = normalizePolyMode(config?.marketWindow || '15m');
  const runLimit = normalizeRunLimit(config?.runLimit || 'unlimited');
  const env = {
    BOT_MARKET_WINDOW: marketWindow,
    MARKET_WINDOW: polyModeToMarketWindow(marketWindow),
  };
  if (runLimit.mode === 'trades') {
    env.BOT_RUN_LIMIT_MODE = 'trades';
    env.BOT_RUN_LIMIT_TRADES = String(runLimit.tradeCount);
  } else if (runLimit.mode === 'end_of_day') {
    env.BOT_RUN_LIMIT_MODE = 'end_of_day';
  } else {
    env.BOT_RUN_LIMIT_MODE = 'unlimited';
  }
  return env;
}

function getEndOfDayMs(now = Date.now()) {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/**
 * Runtime run-limit state for bot.js.
 * @param {NodeJS.ProcessEnv} [env]
 */
function createRunLimitState(env = process.env) {
  const runLimit = normalizeRunLimit({
    mode: env.BOT_RUN_LIMIT_MODE,
    tradeCount: env.BOT_RUN_LIMIT_TRADES,
  });
  return {
    runLimit,
    tradesEntered: 0,
    endOfDayMs: getEndOfDayMs(),
    stopReason: null,
  };
}

function isEndOfDayReached(state, now = Date.now()) {
  return state.runLimit.mode === 'end_of_day' && now >= state.endOfDayMs;
}

function isTradeLimitReached(state) {
  return state.runLimit.mode === 'trades'
    && state.tradesEntered >= state.runLimit.tradeCount;
}

function runLimitLabel(state) {
  if (state.runLimit.mode === 'trades') {
    return `next ${state.runLimit.tradeCount} trade(s)`;
  }
  if (state.runLimit.mode === 'end_of_day') {
    return 'until end of day (local)';
  }
  if (state.runLimit.mode === 'pnl') {
    return 'pnl target/stop (see BOT_SESSION_PNL_*)';
  }
  return 'unlimited';
}

module.exports = {
  RUN_LIMIT_MODES,
  normalizePolyMode,
  normalizeRunLimit,
  defaultBotSessionConfig,
  botConfigToEnv,
  getEndOfDayMs,
  createRunLimitState,
  isEndOfDayReached,
  isTradeLimitReached,
  runLimitLabel,
};
