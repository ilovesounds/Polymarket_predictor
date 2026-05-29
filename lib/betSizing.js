/**
 * Bet sizing modes for paper bot (env + Strategy Lab preset).
 */
const {
  computeBetSize,
  BayesianTracker,
  HARD_FLOOR,
  FEE_RATE,
} = require('../risk/manager_runtime');

const VALID_MODES = ['kelly', 'fixed', 'compound'];
const TIER_KELLY = { 1: 0.08, 2: 0.05, 3: 0.03 };

function parseMode(raw) {
  const mode = String(raw || 'compound').toLowerCase();
  return VALID_MODES.includes(mode) ? mode : 'compound';
}

function defaultSizingFromEnv() {
  const starting = Number.parseFloat(
    process.env.STARTING_CASH || process.env.STARTING_BANKROLL || '20'
  );
  const fixedDefault = Number.parseFloat(process.env.FIXED_BET_USD || String(starting));
  const cashFraction = Number.parseFloat(process.env.POSITION_CASH_FRACTION || '1');
  return {
    sizingMode: parseMode(process.env.SIZING_MODE),
    fixedBetUsd: Number.isFinite(fixedDefault) ? fixedDefault : 5,
    kellyFractionCap: Number.parseFloat(process.env.KELLY_FRACTION_CAP || '0.08'),
    defaultWinRate: Number.parseFloat(process.env.KELLY_DEFAULT_WIN_RATE || '0.55'),
    cashFraction: Number.isFinite(cashFraction) && cashFraction > 0 && cashFraction <= 1
      ? cashFraction
      : 1,
  };
}

function resolveSizingConfig(preset = {}) {
  const env = defaultSizingFromEnv();
  const mode = preset.sizingMode != null ? parseMode(preset.sizingMode) : env.sizingMode;
  const fixedBetUsd = Number.isFinite(preset.fixedBetUsd) ? preset.fixedBetUsd : env.fixedBetUsd;
  const kellyFractionCap = Number.isFinite(preset.kellyFractionCap)
    ? preset.kellyFractionCap
    : env.kellyFractionCap;
  const defaultWinRate = Number.isFinite(preset.defaultWinRate)
    ? preset.defaultWinRate
    : env.defaultWinRate;
  const cashFraction = Number.isFinite(preset.cashFraction)
    ? preset.cashFraction
    : env.cashFraction;
  return {
    sizingMode: mode,
    fixedBetUsd,
    kellyFractionCap,
    defaultWinRate,
    cashFraction,
    tierKelly: TIER_KELLY,
  };
}

function buildSignalStub(entry, stop = 0.45, tier = 1) {
  return {
    tier,
    entry,
    target: 1.0,
    stop,
  };
}

/**
 * @param {number} cash - liquid USDC available for new positions
 * @param {object} sizingConfig - from resolveSizingConfig()
 * @param {object} opts
 * @param {object} [opts.signal]
 * @param {number} [opts.liquidityDepth]
 * @param {object} [opts.bayesianTracker]
 * @param {string} [opts.edgeCase]
 */
function computePositionBetSize(cash, sizingConfig, opts = {}) {
  const fraction = Number.isFinite(sizingConfig?.cashFraction) ? sizingConfig.cashFraction : 1;
  const available = (Number.isFinite(cash) ? cash : 0) * fraction;
  const mode = sizingConfig?.sizingMode || 'compound';

  if (available < HARD_FLOOR) {
    return { betSize: 0, sizingMode: mode, reason: 'hard_floor' };
  }

  if (mode === 'fixed') {
    const fixed = Number.isFinite(sizingConfig.fixedBetUsd) ? sizingConfig.fixedBetUsd : 5;
    const betSize = Math.min(fixed, available);
    return {
      betSize: parseFloat(Math.max(0, betSize).toFixed(2)),
      sizingMode: mode,
      fixedBetUsd: fixed,
    };
  }

  if (mode === 'compound') {
    return {
      betSize: parseFloat(available.toFixed(2)),
      sizingMode: mode,
      cashFraction: fraction,
    };
  }

  if (mode === 'kelly') {
    const signal = opts.signal || buildSignalStub(0.5);
    const liquidityDepth = Number.isFinite(opts.liquidityDepth) ? opts.liquidityDepth : 0;
    const tracker = opts.bayesianTracker;
    const edgeCase = opts.edgeCase || signal.edgeCase;
    let winRate = sizingConfig.defaultWinRate;
    if (tracker && typeof tracker.winRateForEdgeCase === 'function') {
      winRate = tracker.winRateForEdgeCase(edgeCase);
    } else if (tracker && typeof tracker.winRate === 'number') {
      winRate = tracker.winRate;
    }
    if (!Number.isFinite(winRate) || winRate <= 0 || winRate >= 1) {
      winRate = sizingConfig.defaultWinRate;
    }

    let betSize = computeBetSize(available, signal, winRate, liquidityDepth);
    const capFrac = Number.isFinite(sizingConfig.kellyFractionCap)
      ? sizingConfig.kellyFractionCap
      : 0.08;
    if (betSize > 0) {
      const capUsd = available * capFrac * (1 - FEE_RATE);
      betSize = Math.min(betSize, capUsd);
      betSize = parseFloat(Math.max(0, betSize).toFixed(2));
    }

    return {
      betSize,
      sizingMode: mode,
      winRate,
      kellyFractionCap: capFrac,
      tierKellyFrac: TIER_KELLY[signal.tier] ?? TIER_KELLY[1],
    };
  }

  return {
    betSize: parseFloat(available.toFixed(2)),
    sizingMode: 'compound',
  };
}

function previewBetSize(cash, sizingConfig, { entry = 0.5, stop = 0.45, liquidityDepth = 0, bayesianTracker } = {}) {
  return computePositionBetSize(cash, sizingConfig, {
    signal: buildSignalStub(entry, stop),
    liquidityDepth,
    bayesianTracker,
  });
}

function sizingSnapshot(preset = null) {
  const config = resolveSizingConfig(preset || {});
  return {
    ...config,
    formulas: {
      fixed: 'betSize = min(fixedBetUsd, cash × cashFraction)',
      compound: 'betSize = cash × cashFraction',
      kelly: 'Kelly from edge/R:R × tier fraction, capped by kellyFractionCap × cash and 3% liquidity',
    },
  };
}

module.exports = {
  VALID_MODES,
  TIER_KELLY,
  HARD_FLOOR,
  BayesianTracker,
  defaultSizingFromEnv,
  resolveSizingConfig,
  computePositionBetSize,
  previewBetSize,
  sizingSnapshot,
  buildSignalStub,
};
