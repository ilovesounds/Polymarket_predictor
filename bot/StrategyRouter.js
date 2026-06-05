/**
 * Pluggable strategy router — evaluates strategies in priority order.
 */

const { getStrategy, normalizeStrategyId, listStrategies } = require('../signals/strategies_runtime');

/** Template-style aliases → runtime strategy ids */
const STRATEGY_ALIASES = {
  momentum: 'momentum_confirmed_yes_50',
  mean_revert: 'conservative_yes_55',
  low_liq: 'deterministic_yes_50',
  sentiment: 'deterministic_yes_50',
  kelly: 'deterministic_yes_50',
  deterministic: 'deterministic_yes_50',
  conservative: 'conservative_yes_55',
  microstructure_edge: 'microstructure_edge',
  microstructure: 'microstructure_edge',
};

function resolveStrategyId(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return null;
  if (STRATEGY_ALIASES[key]) return STRATEGY_ALIASES[key];
  const normalized = normalizeStrategyId(key);
  return getStrategy(normalized).id === normalized ? normalized : null;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function parseStrategyPriority(env = process.env) {
  const rawList = env.BOT_STRATEGIES || env.STRATEGIES || '';
  if (String(rawList).trim()) {
    const ids = [];
    for (const part of String(rawList).split(',')) {
      const id = resolveStrategyId(part);
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (ids.length) return ids;
  }
  const single = resolveStrategyId(env.BOT_STRATEGY);
  return single ? [single] : [];
}

class StrategyRouter {
  /**
   * @param {string[]} strategyIds — priority order (first match wins)
   */
  constructor(strategyIds) {
    this.strategyIds = (strategyIds || []).map((id) => normalizeStrategyId(id));
    this.strategies = this.strategyIds.map((id) => getStrategy(id));
    if (!this.strategies.length) {
      const fallback = getStrategy('deterministic_yes_50');
      this.strategyIds = [fallback.id];
      this.strategies = [fallback];
    }
  }

  get primaryId() {
    return this.strategyIds[0];
  }

  get primary() {
    return this.strategies[0];
  }

  /**
   * @param {object} ctx — market, yesPrice, liquidityDepth, cash, btcPriceHistory, enriched, btcUpModel, edgeThreshold
   * @returns {{ strategy, decision, strategyId: string } | null}
   */
  evaluate(ctx) {
    for (let i = 0; i < this.strategies.length; i += 1) {
      const strategy = this.strategies[i];
      const decision = strategy.decide(ctx);
      if (decision?.entryEligible) {
        return {
          strategy,
          decision,
          strategyId: this.strategyIds[i],
        };
      }
    }
    const strategy = this.strategies[0];
    const decision = strategy.decide(ctx);
    return {
      strategy,
      decision,
      strategyId: this.strategyIds[0],
    };
  }

  label() {
    if (this.strategyIds.length === 1) {
      return `${this.primary.label} (${this.primaryId})`;
    }
    return `${this.strategyIds.length} strategies [${this.strategyIds.join(' → ')}]`;
  }
}

module.exports = {
  StrategyRouter,
  parseStrategyPriority,
  resolveStrategyId,
  STRATEGY_ALIASES,
  listStrategies,
};
