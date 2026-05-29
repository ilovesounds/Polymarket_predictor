/**
 * Settle expired / resolved open positions (dashboard rows or bot-style objects).
 */

const { getMarketResolution, getMidpoint } = require('../api/polymarket_runtime');
const {
  settleAtResolution,
  positionDirection,
  positionShares,
  marketFromPosition,
} = require('../paper/portfolio');
const {
  isMarketPastEnd,
  resolveSettlementOutcome,
  isNearResolutionPrice,
} = require('./marketResolution');

async function fetchYesPriceForPosition(pos, market) {
  if (Number.isFinite(pos.currentPrice) && isNearResolutionPrice(pos.currentPrice)) {
    return pos.currentPrice;
  }
  const tokenId = pos.tokenIdYes || market.tokenIdYes;
  if (!tokenId) return Number.isFinite(pos.currentPrice) ? pos.currentPrice : null;
  try {
    return await getMidpoint(tokenId);
  } catch (_) {
    return Number.isFinite(pos.currentPrice) ? pos.currentPrice : null;
  }
}

/**
 * @param {object} pos — dashboard portfolio row or bot position
 * @param {Map<string, string>} [resolvedMap] — conditionId → 'Yes'|'No'
 */
async function resolveOutcomeForPosition(pos, resolvedMap = new Map()) {
  const market = marketFromPosition(pos);
  const cid = market.conditionId || pos.marketId;
  if (!cid) return null;

  let gammaOutcome = resolvedMap.get(cid) || null;
  if (!gammaOutcome) {
    try {
      const detail = await getMarketResolution(cid, {
        question: market.question || pos.question,
        slug: pos.slug || market.slug,
      });
      if (detail?.outcome) {
        gammaOutcome = detail.outcome;
        resolvedMap.set(cid, gammaOutcome);
      }
      if (detail?.endTime && !Number.isFinite(market.endTime)) {
        market.endTime = detail.endTime;
      }
    } catch (_) {}
  }

  const yesPrice = await fetchYesPriceForPosition(pos, market);
  const nearResolved = isNearResolutionPrice(yesPrice);
  return resolveSettlementOutcome({
    gammaOutcome,
    yesPrice,
    market,
    requireExpired: !nearResolved,
  });
}

/**
 * Close all settleable positions in a list.
 * @param {object[]} openPositions
 * @param {{ resolvedMap?: Map<string,string>, cash?: number, realizedPnlTotal?: number }} [state]
 */
async function closeResolvedPositions(openPositions = [], state = {}) {
  const resolvedMap = state.resolvedMap || new Map();
  const closed = [];
  const remaining = [];
  let cash = Number.isFinite(state.cash) ? state.cash : 0;
  let realizedPnlTotal = Number.isFinite(state.realizedPnlTotal) ? state.realizedPnlTotal : 0;

  for (const pos of openPositions) {
    const market = marketFromPosition(pos);
    const expired = isMarketPastEnd(market);
    const nearMark = Number.isFinite(pos.currentPrice) && isNearResolutionPrice(pos.currentPrice);

    if (!expired && !nearMark) {
      remaining.push(pos);
      continue;
    }

    const outcome = await resolveOutcomeForPosition(pos, resolvedMap);
    if (!outcome) {
      remaining.push(pos);
      continue;
    }

    const settlement = settleAtResolution(pos, outcome, { cash, market });
    if (!settlement) {
      remaining.push(pos);
      continue;
    }

    cash = settlement.cashAfter;
    realizedPnlTotal += settlement.realizedPnlDelta;
    closed.push({ position: pos, exitEvent: settlement.exitEvent });
  }

  return { closed, remaining, cash, realizedPnlTotal };
}

module.exports = {
  closeResolvedPositions,
  resolveOutcomeForPosition,
  positionDirection,
  positionShares,
  marketFromPosition,
};
