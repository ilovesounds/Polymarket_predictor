const { computeMomentum } = require('../api/feeds_runtime');

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
