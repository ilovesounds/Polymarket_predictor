/**
 * Session lifecycle: indefinite | timed | trades | pnl
 * Unifies lib/botRunConfig run limits with template-style SESSION_MODE.
 */

const {
  createRunLimitState,
  isEndOfDayReached,
  isTradeLimitReached,
  isTimeLimitReached,
  isRunUntilReached,
  runDurationStopReason,
  runLimitLabel,
  normalizeRunLimit,
  normalizeRunDuration,
} = require('../lib/botRunConfig');

const SESSION_MODES = new Set(['indefinite', 'timed', 'trades', 'pnl']);

function parseSessionMode(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'indefinite' || v === 'unlimited' || v === 'forever') return 'indefinite';
  if (v === 'timed' || v === 'end_of_day' || v === 'eod' || v === 'day') return 'timed';
  if (v === 'trades' || v === 'trade_count' || v === 'count') return 'trades';
  if (v === 'pnl' || v === 'profit' || v === 'loss') return 'pnl';
  return null;
}

function sessionModeToRunLimit(mode, env, config) {
  if (mode === 'timed') return { mode: 'end_of_day', tradeCount: null };
  if (mode === 'trades') {
    const raw = config?.runLimitTrades ?? env.BOT_RUN_LIMIT_TRADES ?? env.SESSION_TRADE_COUNT ?? '';
    const n = parseInt(raw, 10);
    return { mode: 'trades', tradeCount: Number.isFinite(n) && n > 0 ? n : 11 };
  }
  if (mode === 'pnl') return { mode: 'pnl', tradeCount: null };
  return { mode: 'unlimited', tradeCount: null };
}

function buildRunDurationFromConfig(config, env = process.env) {
  if (config.runMode || config.runMarketLimit != null || config.runTimeLimitMinutes != null || config.runUntil) {
    return normalizeRunDuration({
      runMode: config.runMode || env.BOT_RUN_MODE,
      runMarketLimit: config.runMarketLimit ?? env.BOT_RUN_MARKET_LIMIT,
      runTimeLimitMinutes: config.runTimeLimitMinutes ?? env.BOT_RUN_TIME_LIMIT_MINUTES,
      runUntil: config.runUntil ?? env.BOT_RUN_UNTIL,
    });
  }
  const sessionMode = parseSessionMode(config.sessionMode);
  if (sessionMode === 'trades') {
    const raw = config?.runLimitTrades ?? env.BOT_RUN_LIMIT_TRADES ?? env.SESSION_TRADE_COUNT ?? '';
    const n = parseInt(raw, 10);
    return normalizeRunDuration({
      runMode: 'markets',
      runMarketLimit: Number.isFinite(n) && n > 0 ? n : 11,
    });
  }
  if (sessionMode === 'timed') {
    return normalizeRunDuration({ runMode: 'until' });
  }
  const legacy = normalizeRunLimit({
    mode: config.runLimitMode || env.BOT_RUN_LIMIT_MODE,
    tradeCount: config.runLimitTrades || env.BOT_RUN_LIMIT_TRADES,
  });
  return normalizeRunDuration({}, legacy);
}

function buildRunLimitFromConfig(config, env = process.env) {
  const sessionMode = parseSessionMode(config.sessionMode);
  if (sessionMode && sessionMode !== 'trades' && sessionMode !== 'timed') {
    if (sessionMode === 'pnl') return { mode: 'pnl', tradeCount: null };
    return sessionModeToRunLimit(sessionMode, env, config);
  }
  const duration = buildRunDurationFromConfig(config, env);
  const { runLimitFromRunDuration } = require('../lib/botRunConfig');
  return runLimitFromRunDuration(duration);
}

class SessionManager {
  /**
   * @param {object} config — from loadConfig()
   * @param {NodeJS.ProcessEnv} [env]
   */
  constructor(config, env = process.env) {
    this.config = config;
    this._runDuration = buildRunDurationFromConfig(config, env);
    this._runLimit = buildRunLimitFromConfig(config, env);
    this.pnlStop = Number.isFinite(config.sessionPnlStop) ? config.sessionPnlStop : null;
    this.pnlTarget = Number.isFinite(config.sessionPnlTarget) ? config.sessionPnlTarget : null;
    if (this._runLimit.mode === 'pnl') {
      if (this.pnlStop == null && env.BOT_SESSION_PNL_STOP) {
        this.pnlStop = parseFloat(env.BOT_SESSION_PNL_STOP);
      }
      if (this.pnlTarget == null && env.BOT_SESSION_PNL_TARGET) {
        this.pnlTarget = parseFloat(env.BOT_SESSION_PNL_TARGET);
      }
    }
  }

  createState() {
    const env = {
      BOT_RUN_MODE: this._runDuration.runMode,
      BOT_RUN_MARKET_LIMIT: String(this._runDuration.runMarketLimit),
      BOT_RUN_TIME_LIMIT_MINUTES: String(this._runDuration.runTimeLimitMinutes),
      BOT_RUN_LIMIT_MODE: this._runLimit.mode === 'end_of_day' ? 'end_of_day' : this._runLimit.mode,
      BOT_RUN_LIMIT_TRADES: this._runLimit.tradeCount != null ? String(this._runLimit.tradeCount) : '',
    };
    if (this._runDuration.runUntil) env.BOT_RUN_UNTIL = this._runDuration.runUntil;
    if (this._runLimit.mode === 'pnl') {
      env.BOT_RUN_LIMIT_MODE = 'unlimited';
    }
    const state = createRunLimitState(env, { runDuration: this._runDuration, startedAt: Date.now() });
    state.runLimit = this._runLimit;
    state.runDuration = this._runDuration;
    state.pnlStop = this.pnlStop;
    state.pnlTarget = this.pnlTarget;
    return state;
  }

  modeLabel(state) {
    if (state.runLimit.mode === 'pnl') {
      const parts = ['pnl session'];
      if (Number.isFinite(state.pnlStop)) parts.push(`stop≤$${state.pnlStop}`);
      if (Number.isFinite(state.pnlTarget)) parts.push(`target≥$${state.pnlTarget}`);
      return parts.join(' | ');
    }
    return runLimitLabel(state);
  }

  isPnlLimitReached(state, realizedPnlTotal) {
    if (state.runLimit.mode !== 'pnl') return false;
    if (Number.isFinite(state.pnlStop) && realizedPnlTotal <= state.pnlStop) {
      return { reached: true, reason: 'pnl_stop' };
    }
    if (Number.isFinite(state.pnlTarget) && realizedPnlTotal >= state.pnlTarget) {
      return { reached: true, reason: 'pnl_target' };
    }
    return { reached: false, reason: null };
  }

  shouldStopNewEntries(state, { realizedPnlTotal = 0, now = Date.now() } = {}) {
    const durationReason = runDurationStopReason(state, now);
    if (durationReason === 'run_until') return { stop: true, reason: 'run_until' };
    if (durationReason === 'end_of_day') return { stop: true, reason: 'end_of_day' };
    if (durationReason === 'time_limit') return { stop: true, reason: 'time_limit' };
    if (durationReason === 'market_limit') return { stop: true, reason: 'market_limit' };
    if (isRunUntilReached(state, now)) return { stop: true, reason: 'run_until' };
    if (isEndOfDayReached(state, now)) return { stop: true, reason: 'end_of_day' };
    if (isTimeLimitReached(state, now)) return { stop: true, reason: 'time_limit' };
    if (isTradeLimitReached(state)) return { stop: true, reason: 'market_limit' };
    const pnl = this.isPnlLimitReached(state, realizedPnlTotal);
    if (pnl.reached) return { stop: true, reason: pnl.reason };
    return { stop: false, reason: null };
  }

  /** Counts market entries (opens), not round-trip exits. */
  recordTradeEntered(state) {
    state.tradesEntered += 1;
    state.marketsTradedCount = state.tradesEntered;
    return state;
  }
}

module.exports = {
  SessionManager,
  SESSION_MODES,
  parseSessionMode,
  buildRunLimitFromConfig,
};
