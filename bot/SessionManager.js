/**
 * Session lifecycle: indefinite | timed | trades | pnl
 * Unifies lib/botRunConfig run limits with template-style SESSION_MODE.
 */

const {
  createRunLimitState,
  isEndOfDayReached,
  isTradeLimitReached,
  runLimitLabel,
  normalizeRunLimit,
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

function buildRunLimitFromConfig(config, env = process.env) {
  const sessionMode = parseSessionMode(config.sessionMode);
  if (sessionMode) {
    return sessionModeToRunLimit(sessionMode, env, config);
  }
  return normalizeRunLimit({
    mode: config.runLimitMode || env.BOT_RUN_LIMIT_MODE,
    tradeCount: config.runLimitTrades || env.BOT_RUN_LIMIT_TRADES,
  });
}

class SessionManager {
  /**
   * @param {object} config — from loadConfig()
   * @param {NodeJS.ProcessEnv} [env]
   */
  constructor(config, env = process.env) {
    this.config = config;
    const runLimit = buildRunLimitFromConfig(config, env);
    this.pnlStop = Number.isFinite(config.sessionPnlStop) ? config.sessionPnlStop : null;
    this.pnlTarget = Number.isFinite(config.sessionPnlTarget) ? config.sessionPnlTarget : null;
    if (runLimit.mode === 'pnl') {
      if (this.pnlStop == null && env.BOT_SESSION_PNL_STOP) {
        this.pnlStop = parseFloat(env.BOT_SESSION_PNL_STOP);
      }
      if (this.pnlTarget == null && env.BOT_SESSION_PNL_TARGET) {
        this.pnlTarget = parseFloat(env.BOT_SESSION_PNL_TARGET);
      }
    }
    this._runLimit = runLimit;
  }

  createState() {
    const env = {
      BOT_RUN_LIMIT_MODE: this._runLimit.mode === 'end_of_day' ? 'end_of_day' : this._runLimit.mode,
      BOT_RUN_LIMIT_TRADES: this._runLimit.tradeCount != null ? String(this._runLimit.tradeCount) : '',
    };
    if (this._runLimit.mode === 'pnl') {
      env.BOT_RUN_LIMIT_MODE = 'unlimited';
    }
    const state = createRunLimitState(env);
    state.runLimit = this._runLimit;
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
    if (isEndOfDayReached(state, now)) return { stop: true, reason: 'end_of_day' };
    if (isTradeLimitReached(state)) return { stop: true, reason: 'trade_limit' };
    const pnl = this.isPnlLimitReached(state, realizedPnlTotal);
    if (pnl.reached) return { stop: true, reason: pnl.reason };
    return { stop: false, reason: null };
  }

  recordTradeEntered(state) {
    state.tradesEntered += 1;
    return state;
  }
}

module.exports = {
  SessionManager,
  SESSION_MODES,
  parseSessionMode,
  buildRunLimitFromConfig,
};
