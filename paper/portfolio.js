/**
 * Paper-mode portfolio math and log formatting.
 * Polymarket CLOB: shares = USDC spent / entry price per share.
 */

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

function formatEntryLog({ direction = 'YES', shares, entryPrice, betSize, market }) {
  const side = String(direction || 'YES').toUpperCase();
  const window = formatMarketWindowLabel(market);
  const title = market?.question ? `${market.question} ${window}` : window;
  return `Bought ${fmtShares(shares)} ${side} shares @ ${Number(entryPrice).toFixed(2)} (${fmtUsd(betSize)}) — ${title}`;
}

function formatExitLog({
  direction = 'YES',
  shares,
  exitPrice,
  pnl,
  market,
  exitReason,
}) {
  const side = String(direction || 'YES').toUpperCase();
  const window = formatMarketWindowLabel(market);
  const title = market?.question ? `${market.question} ${window}` : window;
  const reason = exitReason ? ` (${String(exitReason).replace(/_/g, ' ')})` : '';
  const pnlText = Number.isFinite(pnl) ? ` · PnL ${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}` : '';
  return `Sold ${fmtShares(shares)} ${side} shares @ ${Number(exitPrice).toFixed(2)}${pnlText}${reason} — ${title}`;
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
  formatExitLog,
  revaluePositionRow,
  summarizeOpenPositions,
  calcExitProceeds,
  computePortfolioMetrics,
  buildOpenPositionRow,
  buildPortfolioSnapshot,
};
