/**
 * 5-minute BTC up probability from Binance aggTrade microstructure.
 *
 * Model: threshold ensemble → logistic squash (no training).
 *
 * Inputs (60s unless noted):
 *   OFI = (takerBuyVol - takerSellVol) / totalVol
 *   aggressorRatio = takerBuyVol / totalVol
 *   momentum60s = (midNow - midPast) / midPast
 *   realizedVol30s = sqrt(sum of squared log returns)
 *
 * Scoring (bullish +1, bearish -1 per rule):
 *   OFI > 0.6 / < 0.4; soft bands > 0.55 / < 0.45
 *   aggressor > 0.65 / < 0.35; soft > 0.55 / < 0.45
 *   momentum > +0.03% / < -0.03%
 *
 * P(up) = sigmoid(SCORE_SCALE * score), then vol dampens toward 0.5:
 *   pull = min(0.6, max(0, (vol - VOL_DAMPEN_BASE) / VOL_DAMPEN_BASE))
 *   pUp = pUp + (0.5 - pUp) * pull
 *
 * Cold start: fewer than MIN_TRADES_60S in window → pUp=0.5, ready=false.
 */

const {
  OFI_BUY,
  OFI_SELL,
  AGG_BULL,
  AGG_BEAR,
} = require('./microstructure');

const MIN_TRADES_60S = 5;
const SCORE_SCALE = 0.55;
const MOM_BULL = 0.0003;
const MOM_BEAR = -0.0003;
const VOL_DAMPEN_BASE = 0.00012;
const PUP_CLAMP = { min: 0.05, max: 0.95 };

function sigmoid(x) {
  if (x >= 20) return 1;
  if (x <= -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

function clamp01(p) {
  return Math.max(PUP_CLAMP.min, Math.min(PUP_CLAMP.max, p));
}

/**
 * @param {number|null|undefined} ofi
 * @param {number|null|undefined} agg
 * @param {number|null|undefined} mom
 * @returns {number}
 */
function ensembleScore(ofi, agg, mom) {
  let score = 0;
  if (Number.isFinite(ofi)) {
    if (ofi > OFI_BUY) score += 1;
    else if (ofi < OFI_SELL) score -= 1;
    else if (ofi > 0.55) score += 0.5;
    else if (ofi < 0.45) score -= 0.5;
  }
  if (Number.isFinite(agg)) {
    if (agg > AGG_BULL) score += 1;
    else if (agg < AGG_BEAR) score -= 1;
    else if (agg > 0.55) score += 0.5;
    else if (agg < 0.45) score -= 0.5;
  }
  if (Number.isFinite(mom)) {
    if (mom > MOM_BULL) score += 0.5;
    else if (mom < MOM_BEAR) score -= 0.5;
  }
  return score;
}

function labelFromPUp(pUp) {
  if (pUp > 0.55) return 'bullish';
  if (pUp < 0.45) return 'bearish';
  return 'neutral';
}

function confidenceFromScore(score, ready) {
  if (!ready) return 'low';
  const a = Math.abs(score);
  if (a >= 2) return 'high';
  if (a <= 0.5) return 'low';
  return 'medium';
}

/**
 * @param {object|null|undefined} snapshot — output of microstructure getSnapshot()
 * @param {{ edgeThreshold?: number }} [options]
 */
function computeBtcUpPrediction(snapshot, options = {}) {
  const edgeThreshold = Number.isFinite(options.edgeThreshold)
    ? options.edgeThreshold
    : 0.05;
  const signals = snapshot?.signals || {};
  const ofi = signals.ofi?.value ?? null;
  const aggressorRatio = signals.aggressorRatio?.value ?? null;
  const realizedVol30s = signals.realizedVol30s?.value ?? null;
  const momentum60s = signals.momentum60s?.value ?? null;
  const tradeCount60s = snapshot?.tradeCount60s ?? 0;

  const signalPack = {
    ofi,
    aggressorRatio,
    realizedVol30s,
    momentum60s,
    tradeCount60s,
  };

  const ready = tradeCount60s >= MIN_TRADES_60S
    && Number.isFinite(ofi)
    && Number.isFinite(aggressorRatio);

  if (!ready) {
    return {
      pUp: 0.5,
      confidence: 'low',
      label: 'neutral',
      ready: false,
      coldStart: true,
      score: 0,
      signals: signalPack,
      model: 'threshold_ensemble',
      edgeThreshold,
      coefficients: { scoreScale: SCORE_SCALE, volDampenBase: VOL_DAMPEN_BASE },
    };
  }

  const score = ensembleScore(ofi, aggressorRatio, momentum60s);
  let pUp = sigmoid(SCORE_SCALE * score);

  if (Number.isFinite(realizedVol30s) && realizedVol30s > VOL_DAMPEN_BASE) {
    const pull = Math.min(0.6, (realizedVol30s - VOL_DAMPEN_BASE) / VOL_DAMPEN_BASE);
    pUp = pUp + (0.5 - pUp) * pull;
  }

  pUp = clamp01(pUp);

  return {
    pUp,
    confidence: confidenceFromScore(score, true),
    label: labelFromPUp(pUp),
    ready: true,
    coldStart: false,
    score,
    signals: signalPack,
    model: 'threshold_ensemble',
    edgeThreshold,
    coefficients: { scoreScale: SCORE_SCALE, volDampenBase: VOL_DAMPEN_BASE },
  };
}

/**
 * @param {number} pUp
 * @param {number|null|undefined} polyYes
 * @param {number} [edgeThreshold=0.05]
 */
function compareToPolymarket(pUp, polyYes, edgeThreshold = 0.05) {
  if (!Number.isFinite(polyYes)) {
    return {
      polyYes: null,
      edge: null,
      edgePct: null,
      edgeCents: null,
      entrySignal: false,
    };
  }
  const edge = pUp - polyYes;
  const edgePct = edge * 100;
  const entrySignal = Number.isFinite(edge) && edge >= edgeThreshold;
  return {
    polyYes,
    edge,
    edgePct,
    edgeCents: edgePct,
    entrySignal,
  };
}

/**
 * Merge prediction + Polymarket comparison for bot/dashboard.
 * @param {ReturnType<typeof computeBtcUpPrediction>} prediction
 * @param {number|null|undefined} polyYes
 */
function buildBtcUpModelView(prediction, polyYes) {
  const cmp = compareToPolymarket(
    prediction.pUp,
    polyYes,
    prediction.edgeThreshold ?? 0.05,
  );
  return { ...prediction, ...cmp };
}

module.exports = {
  computeBtcUpPrediction,
  compareToPolymarket,
  buildBtcUpModelView,
  MIN_TRADES_60S,
  SCORE_SCALE,
  VOL_DAMPEN_BASE,
};
