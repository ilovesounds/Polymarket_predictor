/**
 * Shared trade lifecycle event schema + logging helpers.
 * Used by both backtest and live/paper bot runners.
 */

const {
  calcShares,
  calcCostBasis,
  calcCurrentValue,
  calcUnrealizedPnl,
  formatEntryLog,
  formatExitLog,
  summarizeOpenPositions,
  computePortfolioMetrics,
} = require('../paper/portfolio');

const VERBOSE_TRADE_LOGS = process.env.VERBOSE_TRADE_LOGS !== 'false';
const TRADE_LOG_JSON = process.env.TRADE_LOG_JSON !== 'false';

function toNumber(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }
  return Number(Number(value).toFixed(digits));
}

function toIso(value) {
  if (!value) return null;
  if (typeof value === 'number') return new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalizeTradeEvent(input) {
  const entryTime = toIso(input.entryTime);
  const exitTime = toIso(input.exitTime);

  return {
    eventType: input.eventType || null,
    tradeId: input.tradeId || null,
    mode: input.mode || null,
    marketId: input.marketId || null,
    question: input.question || null,
    edgeCase: input.edgeCase ?? null,
    tier: input.tier ?? null,
    direction: input.direction || null,
    entryTime,
    exitTime,
    holdSeconds: input.holdSeconds ?? null,
    timeRemainingAtEntry: input.timeRemainingAtEntry ?? null,
    entryPrice: toNumber(input.entryPrice),
    exitPrice: toNumber(input.exitPrice),
    target: toNumber(input.target),
    stop: toNumber(input.stop),
    betSize: toNumber(input.betSize, 2),
    shares: toNumber(input.shares, 4),
    costBasis: toNumber(input.costBasis, 2),
    currentPrice: toNumber(input.currentPrice),
    currentValue: toNumber(input.currentValue, 2),
    unrealizedPnl: toNumber(input.unrealizedPnl, 4),
    windowMinutes: input.windowMinutes ?? null,
    windowLabel: input.windowLabel || null,
    logLine: input.logLine || null,
    orderbookDepth: toNumber(input.orderbookDepth, 2),
    signalReason: input.signalReason || null,
    exitReason: input.exitReason || null,
    resolvedOutcome: input.resolvedOutcome || null,
    won: typeof input.won === 'boolean' ? input.won : null,
    pnl: toNumber(input.pnl, 4),
    cashBefore: toNumber(input.cashBefore ?? input.bankrollBefore, 2),
    cashAfter: toNumber(input.cashAfter ?? input.bankrollAfter, 2),
    exitProceeds: toNumber(input.exitProceeds, 2),
  };
}

function enrichShareFields(event) {
  const entryPrice = event.entryPrice;
  const exitPrice = event.exitPrice;
  const betSize = event.betSize;
  const priceForShares = event.eventType === 'exit' && Number.isFinite(exitPrice)
    ? entryPrice
    : entryPrice;
  const shares = Number.isFinite(event.shares)
    ? event.shares
    : calcShares(betSize, priceForShares);
  const costBasis = Number.isFinite(event.costBasis)
    ? event.costBasis
    : calcCostBasis(shares, entryPrice, betSize);
  const currentPrice = event.eventType === 'exit'
    ? exitPrice
    : (event.currentPrice ?? entryPrice);
  const currentValue = Number.isFinite(event.currentValue)
    ? event.currentValue
    : calcCurrentValue(shares, currentPrice);
  const unrealizedPnl = event.eventType === 'exit'
    ? event.pnl
    : (Number.isFinite(event.unrealizedPnl)
      ? event.unrealizedPnl
      : calcUnrealizedPnl(shares, entryPrice, currentPrice, costBasis));

  return {
    ...event,
    shares: shares ?? null,
    costBasis: costBasis ?? null,
    currentPrice: currentPrice ?? null,
    currentValue: currentValue ?? null,
    unrealizedPnl: unrealizedPnl ?? null,
  };
}

function formatTradeLogLine(event) {
  if (event.logLine) return event.logLine;
  const market = {
    question: event.question,
    windowMinutes: event.windowMinutes,
    windowLabel: event.windowLabel,
    conditionId: event.marketId,
  };
  if (event.eventType === 'entry') {
    return formatEntryLog({
      direction: event.direction,
      shares: event.shares,
      entryPrice: event.entryPrice,
      betSize: event.betSize,
      market,
      entryIndex: event.entryIndex,
    });
  }
  if (event.eventType === 'exit') {
    return formatExitLog({
      direction: event.direction,
      shares: event.shares,
      exitPrice: event.exitPrice,
      pnl: event.pnl,
      market,
      exitReason: event.exitReason,
      payout: event.exitProceeds,
      resolvedOutcome: event.resolvedOutcome,
    });
  }
  return event.signalReason || event.question || event.tradeId || 'trade event';
}

function formatConciseTradeEvent(event) {
  const side = event.direction || 'N/A';
  const ec = event.edgeCase ? `EC${event.edgeCase}` : 'EC?';
  const outcome = event.won === null ? 'OPEN' : event.won ? 'WIN' : 'LOSS';
  const pnlText = event.pnl === null ? 'n/a' : `$${event.pnl.toFixed(2)}`;
  const sharesText = event.shares === null ? 'n/a' : event.shares.toFixed(2);
  const depthText = event.orderbookDepth === null ? 'n/a' : event.orderbookDepth.toFixed(0);
  const holdText = event.holdSeconds === null ? 'n/a' : `${event.holdSeconds}s`;
  return `[Trade ${event.eventType || 'event'}] ${event.tradeId || 'n/a'} ${ec} ${side} ${sharesText}sh ${outcome} pnl=${pnlText} depth=${depthText} hold=${holdText}`;
}

const { isNatsEnabled } = require('../lib/serviceFlags');
const USE_NATS = isNatsEnabled();

function publishToDashboard(event) {
  if (process.env.ENABLE_DASHBOARD_FEED === 'false') return;
  const logLine = formatTradeLogLine(event);
  const payload = {
    type: event.eventType,
    eventType: event.eventType,
    detail: logLine,
    logLine,
    yesPrice: event.entryPrice ?? event.exitPrice,
    exitPrice: event.exitPrice,
    marketId: event.marketId,
    question: event.question,
    windowMinutes: event.windowMinutes,
    windowLabel: event.windowLabel,
    direction: event.direction,
    shares: event.shares,
    costBasis: event.costBasis,
    currentPrice: event.currentPrice,
    currentValue: event.currentValue,
    unrealizedPnl: event.unrealizedPnl,
    entryPrice: event.entryPrice,
    entryTime: event.entryTime,
    betSize: event.betSize,
    pnl: event.pnl,
    won: event.won,
    mode: event.mode,
    exitReason: event.exitReason,
    resolvedOutcome: event.resolvedOutcome,
    cashBefore: event.cashBefore,
    cashAfter: event.cashAfter,
    tradeId: event.tradeId,
    latencyTiming: event.latencyTiming || null,
  };
  try {
    const { publishDashboardEvent } = require('../dashboard/hub');
    publishDashboardEvent(payload);
  } catch (_) {
    const port = process.env.DASHBOARD_PORT || 3847;
    fetch(`http://127.0.0.1:${port}/api/bot-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'bot',
        timestamp: Date.now(),
        ...payload,
      }),
    }).catch(() => {});
  }
}

function emitTradeEvent(eventInput, opts = {}) {
  const event = enrichShareFields(normalizeTradeEvent(eventInput));
  event.logLine = formatTradeLogLine(event);
  const verbose = opts.verbose ?? VERBOSE_TRADE_LOGS;
  const json = opts.json ?? TRADE_LOG_JSON;

  if (verbose) {
    console.log(formatConciseTradeEvent(event));
    console.log(`[TradeLog] ${event.logLine}`);
  }

  if (json) {
    console.log(`[Trade JSON] ${JSON.stringify(event)}`);
  }

  publishToDashboard(event);

  return event;
}

function publishPortfolioSnapshot(snapshot) {
  if (process.env.ENABLE_DASHBOARD_FEED === 'false') return;
  const openPositions = Array.isArray(snapshot.openPositions) ? snapshot.openPositions : [];
  const totals = summarizeOpenPositions(openPositions);
  const cash = Number.isFinite(snapshot.cash)
    ? snapshot.cash
    : (Number.isFinite(snapshot.bankroll) ? snapshot.bankroll : 0);
  const startingCash = Number.isFinite(snapshot.startingCash)
    ? snapshot.startingCash
    : snapshot.startingBankroll;
  const metrics = computePortfolioMetrics({
    cash,
    startingCash,
    ...totals,
  });
  const payload = {
    type: 'portfolio_snapshot',
    ...snapshot,
    ...totals,
    ...metrics,
    totalEquity: metrics.portfolio,
  };
  try {
    const { publishDashboardEvent } = require('../dashboard/hub');
    publishDashboardEvent(payload);
  } catch (_) {
    const port = process.env.DASHBOARD_PORT || 3847;
    fetch(`http://127.0.0.1:${port}/api/bot-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'bot',
        timestamp: Date.now(),
        ...payload,
      }),
    }).catch(() => {});
  }
}

module.exports = {
  normalizeTradeEvent,
  enrichShareFields,
  formatTradeLogLine,
  formatConciseTradeEvent,
  emitTradeEvent,
  publishPortfolioSnapshot,
  VERBOSE_TRADE_LOGS,
  TRADE_LOG_JSON,
};
