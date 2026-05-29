/**
 * Paper-mode portfolio math and log formatting.
 * Polymarket CLOB: shares = USDC spent / entry price per share.
 */

const { settlementExitPrice } = require('../lib/marketResolution');

const ET = 'America/New_York';

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(Number(value).toFixed(digits));
}

/** shares = betSize / price (USDC / $/share) */
function calcShares(usdc, price) {
  if (!Number.isFinite(usdc) || !Number.isFinite(price) || price <= 0) return 0;
  return usdc / price;
}

function calcCostBasis(shares, entryPrice, betSize) {
  if (Number.isFinite(betSize)) return betSize;
  if (!Number.isFinite(shares) || !Number.isFinite(entryPrice)) return null;
  return shares * entryPrice;
}

function calcCurrentValue(shares, currentPrice) {
  if (!Number.isFinite(shares) || !Number.isFinite(currentPrice)) return null;
  return shares * currentPrice;
}

function calcUnrealizedPnl(shares, entryPrice, currentPrice, costBasis) {
  const value = calcCurrentValue(shares, currentPrice);
  const basis = calcCostBasis(shares, entryPrice, costBasis);
  if (!Number.isFinite(value) || !Number.isFinite(basis)) return null;
  return value - basis;
}

function calcRealizedPnl(shares, entryPrice, exitPrice, betSize) {
  if (Number.isFinite(shares) && Number.isFinite(entryPrice) && Number.isFinite(exitPrice)) {
    return shares * (exitPrice - entryPrice);
  }
  if (Number.isFinite(betSize) && Number.isFinite(entryPrice) && Number.isFinite(exitPrice) && entryPrice > 0) {
    return betSize * ((exitPrice - entryPrice) / entryPrice);
  }
  return null;
}

function fmtShares(shares) {
  if (!Number.isFinite(shares)) return '—';
  return shares.toFixed(2);
}

function fmtUsd(value) {
  if (!Number.isFinite(value)) return '$—';
  return `$${value.toFixed(2)}`;
}

function fmtClockEt(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString('en-US', {
    timeZone: ET,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatMarketWindowLabel(market) {
  if (!market) return 'Unknown market';
  const startMs = market.windowStartTime
    ?? (Number.isFinite(market.endTime) && market.windowMinutes
      ? market.endTime - market.windowMinutes * 60_000
      : null);
  const endMs = market.endTime;
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    return `${fmtClockEt(startMs)}–${fmtClockEt(endMs)} ET`;
  }
  if (market.question) return market.question;
  return market.conditionId ? `${String(market.conditionId).slice(0, 8)}…` : 'Unknown market';
}

function formatEntryLog({ direction = 'YES', shares, entryPrice, betSize, market, entryIndex }) {
  const side = String(direction || 'YES').toUpperCase();
  const window = formatMarketWindowLabel(market);
  const title = market?.question ? `${market.question} ${window}` : window;
  if (Number.isFinite(entryIndex) && entryIndex > 1) {
    const ord = entryIndex === 2 ? '2nd' : entryIndex === 3 ? '3rd' : `${entryIndex}th`;
    return `Bought ${ord} ${side} entry @ ${Number(entryPrice).toFixed(2)} (${fmtUsd(betSize)}) — ${fmtShares(shares)} shares · ${title}`;
  }
  return `Bought ${fmtShares(shares)} ${side} shares @ ${Number(entryPrice).toFixed(2)} (${fmtUsd(betSize)}) — ${title}`;
}

function formatResolutionExitLog({
  direction = 'YES',
  shares,
  payout,
  pnl,
  outcome,
}) {
  const side = String(direction || 'YES').toUpperCase();
  const won = settlementExitPrice(outcome, side) === 1.0;
  const result = won ? 'won' : 'lost';
  const pnlText = Number.isFinite(pnl)
    ? ` | PnL=${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}`
    : '';
  return `[Exit RESOLVED] ${side} ${result} | shares=${fmtShares(shares)} | payout=${fmtUsd(payout)}${pnlText}`;
}

function formatExitLog({
  direction = 'YES',
  shares,
  exitPrice,
  pnl,
  market,
  exitReason,
  payout,
  resolvedOutcome,
}) {
  if (exitReason === 'resolution') {
    return formatResolutionExitLog({
      direction,
      shares,
      payout: Number.isFinite(payout) ? payout : calcExitProceeds(shares, exitPrice),
      pnl,
      outcome: resolvedOutcome,
    });
  }
  const side = String(direction || 'YES').toUpperCase();
  const window = formatMarketWindowLabel(market);
  const title = market?.question ? `${market.question} ${window}` : window;
  const reason = exitReason ? ` (${String(exitReason).replace(/_/g, ' ')})` : '';
  const pnlText = Number.isFinite(pnl) ? ` · PnL ${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}` : '';
  return `Sold ${fmtShares(shares)} ${side} shares @ ${Number(exitPrice).toFixed(2)}${pnlText}${reason} — ${title}`;
}

function positionDirection(pos) {
  return pos.signal?.direction || pos.direction || pos.side || 'YES';
}

function positionShares(pos) {
  if (Number.isFinite(pos.shares)) return pos.shares;
  return calcShares(pos.costBasis ?? pos.betSize, pos.entryPrice);
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

/**
 * Cash-settle an open position at market resolution ($1/share if won, $0 if lost).
 * @param {object} position
 * @param {'Yes'|'No'} outcome
 * @param {{ cash?: number, exitTime?: number, market?: object }} [opts]
 * @returns {{ exitEvent: object, cashAfter: number, realizedPnlDelta: number, proceeds: number }|null}
 */
function settleAtResolution(position, outcome, opts = {}) {
  if (outcome !== 'Yes' && outcome !== 'No') return null;

  const market = opts.market || marketFromPosition(position);
  const direction = positionDirection(position);
  const exitPrice = settlementExitPrice(outcome, direction);
  if (exitPrice == null) return null;

  const shares = positionShares(position);
  const entryPrice = position.entryPrice;
  const costBasis = positionCostBasis(position, shares);
  const pnl = calcRealizedPnl(shares, entryPrice, exitPrice, costBasis);
  const proceeds = calcExitProceeds(shares, exitPrice);
  const cashBefore = Number.isFinite(opts.cash) ? opts.cash : 0;
  const cashAfter = Number.isFinite(proceeds) ? cashBefore + proceeds : cashBefore;
  const exitTime = opts.exitTime || Date.now();
  const won = Number.isFinite(pnl) ? pnl > 0 : exitPrice > entryPrice;

  const exitEvent = {
    eventType: 'exit',
    type: 'exit',
    tradeId: position.tradeId || null,
    marketId: market.conditionId || position.marketId || null,
    question: market.question || position.question || null,
    windowMinutes: market.windowMinutes ?? position.windowMinutes ?? null,
    windowLabel: position.windowLabel || formatMarketWindowLabel(market),
    direction,
    entryTime: position.entryTime,
    exitTime,
    holdSeconds: position.entryTime ? Math.round((exitTime - position.entryTime) / 1000) : null,
    entryPrice,
    exitPrice,
    betSize: costBasis,
    shares,
    costBasis,
    exitReason: 'resolution',
    won,
    pnl,
    cashBefore,
    cashAfter,
    exitProceeds: proceeds,
    resolvedOutcome: outcome,
    logLine: formatResolutionExitLog({
      direction,
      shares,
      payout: proceeds,
      pnl,
      outcome,
    }),
  };

  return {
    exitEvent,
    cashAfter,
    realizedPnlDelta: Number.isFinite(pnl) ? pnl : 0,
    proceeds: Number.isFinite(proceeds) ? proceeds : 0,
  };
}

function revaluePositionRow(pos, currentPrice) {
  const shares = Number.isFinite(pos.shares)
    ? pos.shares
    : calcShares(pos.costBasis ?? pos.betSize, pos.entryPrice);
  const entryPrice = pos.entryPrice;
  const costBasis = calcCostBasis(shares, entryPrice, pos.costBasis ?? pos.betSize);
  const currentValue = calcCurrentValue(shares, currentPrice);
  const unrealizedPnl = calcUnrealizedPnl(shares, entryPrice, currentPrice, costBasis);
  return {
    ...pos,
    shares: round(shares, 4),
    costBasis: round(costBasis, 2),
    currentPrice: round(currentPrice, 4),
    currentValue: round(currentValue, 2),
    unrealizedPnl: round(unrealizedPnl, 4),
  };
}

function summarizeOpenPositions(openPositions = []) {
  let openPositionValue = 0;
  let totalUnrealizedPnl = 0;
  for (const pos of openPositions) {
    if (Number.isFinite(pos.currentValue)) openPositionValue += pos.currentValue;
    if (Number.isFinite(pos.unrealizedPnl)) totalUnrealizedPnl += pos.unrealizedPnl;
  }
  return {
    openPositionCount: openPositions.length,
    openPositionValue: round(openPositionValue, 2),
    totalUnrealizedPnl: round(totalUnrealizedPnl, 4),
  };
}

/** Proceeds returned to cash when a position is closed (shares × exit price). */
function calcExitProceeds(shares, exitPrice) {
  if (!Number.isFinite(shares) || !Number.isFinite(exitPrice)) return null;
  return shares * exitPrice;
}

/**
 * Portfolio equity = cash + mark-to-market open positions.
 * ROI% = (portfolio - startingCash) / startingCash × 100.
 */
function computePortfolioMetrics({
  cash = 0,
  startingCash = 0,
  openPositionValue = 0,
  totalUnrealizedPnl = 0,
  openPositionCount = 0,
} = {}) {
  const portfolio = cash + openPositionValue;
  const roiPct = Number.isFinite(startingCash) && startingCash > 0
    ? ((portfolio - startingCash) / startingCash) * 100
    : null;
  return {
    cash: round(cash, 2),
    startingCash: round(startingCash, 2),
    openPositionValue: round(openPositionValue, 2),
    portfolio: round(portfolio, 2),
    totalUnrealizedPnl: round(totalUnrealizedPnl, 4),
    openPositionCount,
    roiPct: roiPct == null ? null : round(roiPct, 4),
  };
}

function buildOpenPositionRow(position, currentPrice) {
  const shares = position.shares ?? calcShares(position.betSize, position.entryPrice);
  const entryPrice = position.entryPrice;
  const costBasis = calcCostBasis(shares, entryPrice, position.betSize);
  const currentValue = calcCurrentValue(shares, currentPrice);
  const unrealizedPnl = calcUnrealizedPnl(shares, entryPrice, currentPrice, costBasis);

  return {
    tradeId: position.tradeId,
    marketId: position.market?.conditionId || position.marketId,
    tokenIdYes: position.market?.tokenIdYes || position.tokenIdYes || null,
    question: position.market?.question || null,
    windowMinutes: position.market?.windowMinutes ?? null,
    windowLabel: formatMarketWindowLabel(position.market),
    side: position.signal?.direction || position.direction || 'YES',
    shares: round(shares, 4),
    entryPrice: round(entryPrice, 4),
    costBasis: round(costBasis, 2),
    currentPrice: round(currentPrice, 4),
    currentValue: round(currentValue, 2),
    unrealizedPnl: round(unrealizedPnl, 4),
    entryTime: position.entryTime,
    endTime: position.market?.endTime ?? position.endTime ?? null,
    strategyId: position.strategyId || null,
    entryIndex: position.entryIndex ?? null,
  };
}

function buildPortfolioSnapshot({
  openPositions = {},
  cash,
  startingCash,
  realizedPnlTotal = 0,
}) {
  const positions = Array.isArray(openPositions)
    ? openPositions
    : Object.values(openPositions);
  const totals = summarizeOpenPositions(positions);
  const metrics = computePortfolioMetrics({
    cash,
    startingCash,
    ...totals,
  });
  return {
    ...metrics,
    realizedPnlTotal: round(realizedPnlTotal, 4),
    openPositions: positions,
  };
}

module.exports = {
  calcShares,
  calcCostBasis,
  calcCurrentValue,
  calcUnrealizedPnl,
  calcRealizedPnl,
  fmtShares,
  fmtUsd,
  formatMarketWindowLabel,
  formatEntryLog,
  formatResolutionExitLog,
  formatExitLog,
  positionDirection,
  positionShares,
  positionCostBasis,
  marketFromPosition,
  settleAtResolution,
  revaluePositionRow,
  summarizeOpenPositions,
  calcExitProceeds,
  computePortfolioMetrics,
  buildOpenPositionRow,
  buildPortfolioSnapshot,
};
