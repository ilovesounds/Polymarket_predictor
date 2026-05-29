/**
 * Bot session config: market windows and run duration (indefinite | markets | time | until).
 * Market count = entries opened (not round-trip exits).
 */

const { normalizePolyMode, polyModeToMarketWindow } = require('./marketSelection');

const RUN_LIMIT_MODES = new Set(['unlimited', 'trades', 'end_of_day', 'pnl']);
const RUN_MODES = new Set(['indefinite', 'markets', 'time', 'until']);

function parseRunLimitMode(raw) {
  const v = String(raw || 'unlimited').trim().toLowerCase();
  if (v === 'trades' || v === 'trade_count' || v === 'count' || v === 'markets') return 'trades';
  if (v === 'end_of_day' || v === 'eod' || v === 'day' || v === 'timed') return 'end_of_day';
  if (v === 'pnl' || v === 'profit' || v === 'loss') return 'pnl';
  if (v === 'indefinite' || v === 'unlimited' || v === 'forever') return 'unlimited';
  return 'unlimited';
}

function parseRunMode(raw) {
  const v = String(raw || 'indefinite').trim().toLowerCase();
  if (v === 'markets' || v === 'market' || v === 'trades' || v === 'trade_count') return 'markets';
  if (v === 'time' || v === 'timed' || v === 'minutes' || v === 'duration') return 'time';
  if (v === 'until' || v === 'run_until' || v === 'deadline') return 'until';
  if (v === 'indefinite' || v === 'unlimited' || v === 'forever') return 'indefinite';
  return 'indefinite';
}

function parsePositiveInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * @param {string|{ mode?: string, tradeCount?: number }} input
 * @returns {{ mode: 'unlimited'|'trades'|'end_of_day'|'pnl', tradeCount: number|null }}
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

/**
 * @param {object} [input]
 * @param {{ mode?: string, tradeCount?: number|null }} [legacyRunLimit]
 * @returns {{ runMode: string, runMarketLimit: number, runTimeLimitMinutes: number, runUntil: string|null }}
 */
function normalizeRunDuration(input = {}, legacyRunLimit = null) {
  if (input.runMode != null || input.runMarketLimit != null || input.runTimeLimitMinutes != null || input.runUntil != null) {
    const runMode = parseRunMode(input.runMode);
    const runMarketLimit = parsePositiveInt(input.runMarketLimit, 10);
    const runTimeLimitMinutes = parsePositiveInt(input.runTimeLimitMinutes, 60);
    let runUntil = null;
    if (input.runUntil != null && input.runUntil !== '') {
      const parsed = Date.parse(String(input.runUntil));
      runUntil = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
    }
    return { runMode, runMarketLimit, runTimeLimitMinutes, runUntil };
  }

  const env = input._env || process.env;
  if (env?.BOT_RUN_MODE) {
    return normalizeRunDuration({
      runMode: env.BOT_RUN_MODE,
      runMarketLimit: env.BOT_RUN_MARKET_LIMIT,
      runTimeLimitMinutes: env.BOT_RUN_TIME_LIMIT_MINUTES,
      runUntil: env.BOT_RUN_UNTIL,
    });
  }

  const rl = legacyRunLimit || input.runLimit;
  if (rl) {
    const norm = normalizeRunLimit(rl);
    if (norm.mode === 'trades') {
      return {
        runMode: 'markets',
        runMarketLimit: norm.tradeCount || 10,
        runTimeLimitMinutes: 60,
        runUntil: null,
      };
    }
    if (norm.mode === 'end_of_day') {
      return { runMode: 'until', runMarketLimit: 10, runTimeLimitMinutes: 60, runUntil: null };
    }
  }

  return { runMode: 'indefinite', runMarketLimit: 10, runTimeLimitMinutes: 60, runUntil: null };
}

/** Sync legacy runLimit object from run duration fields. */
function runLimitFromRunDuration(duration) {
  const d = normalizeRunDuration(duration);
  if (d.runMode === 'markets') {
    return { mode: 'trades', tradeCount: d.runMarketLimit };
  }
  if (d.runMode === 'until' && !d.runUntil) {
    return { mode: 'end_of_day', tradeCount: null };
  }
  return { mode: 'unlimited', tradeCount: null };
}

function defaultBotSessionConfig(env = process.env) {
  const marketWindow = normalizePolyMode(
    env.BOT_MARKET_WINDOW || env.DASHBOARD_POLY_MODE || env.MARKET_WINDOW || '15m'
  );
  const runDuration = normalizeRunDuration({ _env: env });
  const runLimit = runLimitFromRunDuration(runDuration);
  if (!env.BOT_RUN_MODE) {
    const mode = parseRunLimitMode(env.BOT_RUN_LIMIT_MODE);
    const parsedCount = parseInt(env.BOT_RUN_LIMIT_TRADES || '', 10);
    const tradeCount = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 11;
    if (mode === 'trades') {
      runLimit.mode = 'trades';
      runLimit.tradeCount = tradeCount;
      runDuration.runMode = 'markets';
      runDuration.runMarketLimit = tradeCount;
    } else if (mode === 'end_of_day') {
      runLimit.mode = 'end_of_day';
      runDuration.runMode = 'until';
    }
  }
  return { marketWindow, runLimit, runDuration };
}

/**
 * Env vars passed to bot.js child process.
 */
function botConfigToEnv(config) {
  const marketWindow = normalizePolyMode(config?.marketWindow || '15m');
  const runDuration = normalizeRunDuration(config || {}, config?.runLimit);
  const runLimit = runLimitFromRunDuration(runDuration);
  const env = {
    BOT_MARKET_WINDOW: marketWindow,
    MARKET_WINDOW: polyModeToMarketWindow(marketWindow),
    BOT_RUN_MODE: runDuration.runMode,
    BOT_RUN_MARKET_LIMIT: String(runDuration.runMarketLimit),
    BOT_RUN_TIME_LIMIT_MINUTES: String(runDuration.runTimeLimitMinutes),
  };
  if (runDuration.runUntil) env.BOT_RUN_UNTIL = runDuration.runUntil;
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
 * @param {{ runDuration?: object, startedAt?: number }} [seed]
 */
function createRunLimitState(env = process.env, seed = {}) {
  const runDuration = seed.runDuration || normalizeRunDuration({ _env: env });
  const runLimit = runLimitFromRunDuration(runDuration);
  const startedAt = Number.isFinite(seed.startedAt) ? seed.startedAt : Date.now();
  return {
    runLimit,
    runDuration,
    tradesEntered: 0,
    marketsTradedCount: 0,
    startedAt,
    endOfDayMs: getEndOfDayMs(startedAt),
    stopReason: null,
  };
}

function isEndOfDayReached(state, now = Date.now()) {
  if (state.runDuration?.runMode === 'until' && !state.runDuration?.runUntil) {
    return now >= state.endOfDayMs;
  }
  return state.runLimit.mode === 'end_of_day' && now >= state.endOfDayMs;
}

function isTradeLimitReached(state) {
  const d = state.runDuration || {};
  if (d.runMode === 'markets') {
    return state.marketsTradedCount >= d.runMarketLimit;
  }
  return state.runLimit.mode === 'trades'
    && state.tradesEntered >= state.runLimit.tradeCount;
}

function isTimeLimitReached(state, now = Date.now()) {
  const d = state.runDuration || {};
  if (d.runMode !== 'time') return false;
  const limitMs = d.runTimeLimitMinutes * 60_000;
  return Number.isFinite(state.startedAt) && now - state.startedAt >= limitMs;
}

function isRunUntilReached(state, now = Date.now()) {
  const until = state.runDuration?.runUntil;
  if (!until) return false;
  const untilMs = Date.parse(until);
  return Number.isFinite(untilMs) && now >= untilMs;
}

function runDurationStopReason(state, now = Date.now()) {
  if (isRunUntilReached(state, now)) return 'run_until';
  if (isEndOfDayReached(state, now)) return 'end_of_day';
  if (isTimeLimitReached(state, now)) return 'time_limit';
  if (isTradeLimitReached(state)) return 'market_limit';
  return null;
}

function runLimitLabel(state) {
  const d = state.runDuration || {};
  if (d.runMode === 'markets') {
    return `stop after ${d.runMarketLimit} market entries`;
  }
  if (d.runMode === 'time') {
    return `stop after ${d.runTimeLimitMinutes} min`;
  }
  if (d.runMode === 'until' && d.runUntil) {
    return `stop at ${d.runUntil}`;
  }
  if (state.runLimit.mode === 'trades') {
    return `next ${state.runLimit.tradeCount} trade(s)`;
  }
  if (state.runLimit.mode === 'end_of_day' || (d.runMode === 'until' && !d.runUntil)) {
    return 'until end of day (local)';
  }
  if (state.runLimit.mode === 'pnl') {
    return 'pnl target/stop (see BOT_SESSION_PNL_*)';
  }
  return 'indefinite';
}

function runStopMessage(state, reason) {
  const d = state.runDuration || {};
  if (reason === 'market_limit' || reason === 'trade_limit') {
    const n = d.runMarketLimit ?? state.runLimit?.tradeCount ?? state.marketsTradedCount;
    return `run limit reached: ${state.marketsTradedCount}/${n} markets traded (entries)`;
  }
  if (reason === 'time_limit') {
    return `run limit reached: ${d.runTimeLimitMinutes} min elapsed`;
  }
  if (reason === 'run_until') {
    return `run limit reached: stop time ${d.runUntil}`;
  }
  if (reason === 'end_of_day') {
    return 'run limit reached: end of day (local)';
  }
  return `run limit reached (${reason || 'unknown'})`;
}

/**
 * @returns {{ runMode: string, marketsTradedCount: number, marketLimit: number|null, elapsedMs: number, timeLimitMs: number|null, remainingMs: number|null, label: string }}
 */
function buildRunProgressSnapshot(state, now = Date.now()) {
  const d = state.runDuration || normalizeRunDuration({});
  const elapsedMs = Number.isFinite(state.startedAt) ? Math.max(0, now - state.startedAt) : 0;
  const parts = [];

  let marketLimit = null;
  if (d.runMode === 'markets') {
    marketLimit = d.runMarketLimit;
    parts.push(`${state.marketsTradedCount}/${marketLimit} markets`);
  }

  let timeLimitMs = null;
  let remainingMs = null;
  if (d.runMode === 'time') {
    timeLimitMs = d.runTimeLimitMinutes * 60_000;
    remainingMs = Math.max(0, timeLimitMs - elapsedMs);
    const mins = Math.ceil(remainingMs / 60_000);
    parts.push(`${mins}m remaining`);
  }

  if (d.runUntil) {
    const untilMs = Date.parse(d.runUntil);
    if (Number.isFinite(untilMs)) {
      const untilRemaining = Math.max(0, untilMs - now);
      if (untilRemaining > 0) {
        parts.push(`${Math.ceil(untilRemaining / 60_000)}m until stop`);
      }
    }
  }

  return {
    runMode: d.runMode,
    runMarketLimit: d.runMode === 'markets' ? d.runMarketLimit : null,
    runTimeLimitMinutes: d.runMode === 'time' ? d.runTimeLimitMinutes : null,
    runUntil: d.runUntil || null,
    marketsTradedCount: state.marketsTradedCount,
    marketLimit,
    elapsedMs,
    timeLimitMs,
    remainingMs,
    startedAt: state.startedAt,
    label: parts.length ? parts.join(' · ') : 'indefinite',
  };
}

module.exports = {
  RUN_LIMIT_MODES,
  RUN_MODES,
  normalizePolyMode,
  normalizeRunLimit,
  normalizeRunDuration,
  runLimitFromRunDuration,
  defaultBotSessionConfig,
  botConfigToEnv,
  getEndOfDayMs,
  createRunLimitState,
  isEndOfDayReached,
  isTradeLimitReached,
  isTimeLimitReached,
  isRunUntilReached,
  runDurationStopReason,
  runLimitLabel,
  runStopMessage,
  buildRunProgressSnapshot,
  parseRunMode,
};
