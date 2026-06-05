const { computeMomentum } = require('../api/feeds_runtime');
const { buildBtcUpModelView } = require('./btcUpModel');

const STRATEGIES = {
  deterministic_yes_50: {
    id: 'deterministic_yes_50',
    label: 'Deterministic YES >= 0.50',
    description: 'Enter YES when midpoint is at least 0.50.',
    stop: 0.45,
    decide({ yesPrice }) {
      const entryEligible = Number.isFinite(yesPrice) && yesPrice >= 0.5;
      return {
        entryEligible,
        edgeCase: 'YES_GE_0_50',
        reason: `YES midpoint ${yesPrice?.toFixed?.(3) || 'n/a'} ${entryEligible ? '>=' : '<'} 0.500`,
      };
    },
  },
  conservative_yes_55: {
    id: 'conservative_yes_55',
    label: 'Conservative YES >= 0.55',
    description: 'Enter YES only when midpoint is at least 0.55.',
    stop: 0.5,
    decide({ yesPrice }) {
      const entryEligible = Number.isFinite(yesPrice) && yesPrice >= 0.55;
      return {
        entryEligible,
        edgeCase: 'YES_GE_0_55',
        reason: `YES midpoint ${yesPrice?.toFixed?.(3) || 'n/a'} ${entryEligible ? '>=' : '<'} 0.550`,
      };
    },
  },
  momentum_confirmed_yes_50: {
    id: 'momentum_confirmed_yes_50',
    label: 'YES >= 0.50 + momentum up',
    description: 'Enter YES when midpoint >= 0.50 and Binance short momentum is up.',
    stop: 0.46,
    decide({ yesPrice, btcPriceHistory }) {
      const momentum = computeMomentum(btcPriceHistory || [], 4);
      const entryEligible = Number.isFinite(yesPrice) && yesPrice >= 0.5 && momentum === 'up';
      return {
        entryEligible,
        edgeCase: 'YES_GE_0_50_MOMENTUM_UP',
        reason: `YES ${yesPrice?.toFixed?.(3) || 'n/a'} >= 0.500 and momentum=${momentum}`,
      };
    },
  },
  microstructure_edge: {
    id: 'microstructure_edge',
    label: 'Microstructure edge (P(up) vs YES)',
    description: 'Enter YES when model P(BTC up in 5m) exceeds Polymarket YES by BOT_EDGE_THRESHOLD.',
    stop: 0.45,
    decide({ yesPrice, btcUpModel, edgeThreshold }) {
      const threshold = Number.isFinite(edgeThreshold)
        ? edgeThreshold
        : (btcUpModel?.edgeThreshold ?? 0.05);
      const model = btcUpModel && typeof btcUpModel === 'object'
        ? btcUpModel
        : buildBtcUpModelView(
          { pUp: 0.5, ready: false, coldStart: true, edgeThreshold: threshold },
          yesPrice,
        );
      const pPct = Number.isFinite(model.pUp) ? (model.pUp * 100).toFixed(0) : 'n/a';
      const yPct = Number.isFinite(yesPrice) ? (yesPrice * 100).toFixed(0) : 'n/a';
      const edgePct = Number.isFinite(model.edgePct)
        ? `${model.edgePct >= 0 ? '+' : ''}${model.edgePct.toFixed(0)}`
        : 'n/a';
      const entryEligible = Boolean(model.ready)
        && Boolean(model.entrySignal)
        && Number.isFinite(yesPrice);
      return {
        entryEligible,
        edgeCase: 'MICROSTRUCTURE_EDGE',
        edgeCents: Number.isFinite(model.edgeCents) ? model.edgeCents : model.edgePct,
        reason: `P(up)=${pPct}% | Poly YES=${yPct}% | edge=${edgePct}% (need ≥${(threshold * 100).toFixed(0)}%)`,
      };
    },
  },
};

function strategyStopForProfile(strategyId, profile = {}, entryPrice = 0.5) {
  const strategy = getStrategy(strategyId);
  const { resolveStopThreshold } = require('../lib/botProfile');
  return resolveStopThreshold(entryPrice, profile, strategy.stop);
}

function listStrategies(profile = null) {
  return Object.values(STRATEGIES).map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    stop: profile ? strategyStopForProfile(s.id, profile) : s.stop,
    strategyStop: s.stop,
  }));
}

function getStrategy(strategyId) {
  return STRATEGIES[strategyId] || STRATEGIES.deterministic_yes_50;
}

function normalizeStrategyId(strategyId) {
  return STRATEGIES[strategyId] ? strategyId : 'deterministic_yes_50';
}

module.exports = {
  STRATEGIES,
  listStrategies,
  getStrategy,
  normalizeStrategyId,
  strategyStopForProfile,
};
