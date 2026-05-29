/**
 * Settle expired / resolved open positions (dashboard rows or bot-style objects).
 */

const { getMarketResolution, getMidpoint } = require('../api/polymarket_runtime');
const {
  calcShares,
  calcRealizedPnl,
  calcExitProceeds,
  formatExitLog,
  formatMarketWindowLabel,
} = require('../paper/portfolio');
const {
  isMarketPastEnd,
  resolveSettlementOutcome,
  settlementExitPrice,
  isNearResolutionPrice,
} = require('./marketResolution');

function positionDirection(pos) {
  return pos.side || pos.direction || pos.signal?.direction || 'YES';
}

function positionShares(pos) {
  if (Number.isFinite(pos.shares)) return pos.shares;
  const basis = pos.costBasis ?? pos.betSize;
  return calcShares(basis, pos.entryPrice);
}

function positionCostBasis(pos, shares) {
  if (Number.isFinite(pos.costBasis)) return pos.costBasis;
  if (Number.isFinite(pos.betSize)) return pos.betSize;
  if (Number.isFinite(shares) && Number.isFinite(pos.entryPrice)) return shares * pos.entryPrice;
  return null;
}

function marketFromPosition(pos) {
  if (pos.market) return pos.market;
  return {
    conditionId: pos.marketId,
    question: pos.question,
    endTime: pos.endTime ?? null,
    windowMinutes: pos.windowMinutes ?? null,
    tokenIdYes: pos.tokenIdYes ?? null,
  };
}

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

    const direction = positionDirection(pos);
    const exitPrice = settlementExitPrice(outcome, direction);
    const shares = positionShares(pos);
    const entryPrice = pos.entryPrice;
    const costBasis = positionCostBasis(pos, shares);
    const pnl = calcRealizedPnl(shares, entryPrice, exitPrice, costBasis);
    const proceeds = calcExitProceeds(shares, exitPrice);
    const cashBefore = cash;

    if (Number.isFinite(proceeds)) cash += proceeds;
    if (Number.isFinite(pnl)) realizedPnlTotal += pnl;

    const exitTime = Date.now();
    const exitEvent = {
      eventType: 'exit',
      type: 'exit',
      tradeId: pos.tradeId || null,
      marketId: market.conditionId || pos.marketId,
      question: market.question || pos.question,
      windowMinutes: market.windowMinutes ?? pos.windowMinutes ?? null,
      windowLabel: pos.windowLabel || formatMarketWindowLabel(market),
      direction,
      entryTime: pos.entryTime,
      exitTime,
      holdSeconds: pos.entryTime ? Math.round((exitTime - pos.entryTime) / 1000) : null,
      entryPrice,
      exitPrice,
      betSize: costBasis,
      shares,
      costBasis,
      exitReason: 'resolution',
      won: Number.isFinite(pnl) ? pnl > 0 : exitPrice > entryPrice,
      pnl,
      cashBefore,
      cashAfter: cash,
      exitProceeds: proceeds,
      resolvedOutcome: outcome,
      logLine: formatExitLog({
        direction,
        shares,
        exitPrice,
        pnl,
        market,
        exitReason: 'resolution',
      }),
    };

    closed.push({ position: pos, exitEvent });
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
