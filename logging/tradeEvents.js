/**
 * Shared trade lifecycle event schema + logging helpers.
 * Used by both backtest and live/paper bot runners.
 */

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
    orderbookDepth: toNumber(input.orderbookDepth, 2),
    signalReason: input.signalReason || null,
    exitReason: input.exitReason || null,
    won: typeof input.won === 'boolean' ? input.won : null,
    pnl: toNumber(input.pnl, 4),
    bankrollBefore: toNumber(input.bankrollBefore, 2),
    bankrollAfter: toNumber(input.bankrollAfter, 2),
  };
}

function formatConciseTradeEvent(event) {
  const side = event.direction || 'N/A';
  const ec = event.edgeCase ? `EC${event.edgeCase}` : 'EC?';
  const outcome = event.won === null ? 'OPEN' : event.won ? 'WIN' : 'LOSS';
  const pnlText = event.pnl === null ? 'n/a' : `$${event.pnl.toFixed(2)}`;
  const depthText = event.orderbookDepth === null ? 'n/a' : event.orderbookDepth.toFixed(0);
  const holdText = event.holdSeconds === null ? 'n/a' : `${event.holdSeconds}s`;
  return `[Trade ${event.eventType || 'event'}] ${event.tradeId || 'n/a'} ${ec} ${side} ${outcome} pnl=${pnlText} depth=${depthText} hold=${holdText}`;
}

const USE_NATS = process.env.USE_NATS !== 'false' && process.env.NATS_URL !== 'disabled';

function publishToDashboard(event) {
  if (process.env.ENABLE_DASHBOARD_FEED === 'false') return;
  const payload = {
    type: event.eventType,
    eventType: event.eventType,
    detail: event.signalReason || event.exitReason || event.question,
    yesPrice: event.entryPrice ?? event.exitPrice,
    marketId: event.marketId,
    direction: event.direction,
    pnl: event.pnl,
    won: event.won,
    mode: event.mode,
    bankrollBefore: event.bankrollBefore,
    bankrollAfter: event.bankrollAfter,
    tradeId: event.tradeId,
  };
  try {
    const { publishDashboardEvent } = require('../dashboard/hub');
    publishDashboardEvent(payload);
  } catch (_) {
    if (USE_NATS) return;
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
  const event = normalizeTradeEvent(eventInput);
  const verbose = opts.verbose ?? VERBOSE_TRADE_LOGS;
  const json = opts.json ?? TRADE_LOG_JSON;

  if (verbose) {
    console.log(formatConciseTradeEvent(event));
  }

  if (json) {
    console.log(`[Trade JSON] ${JSON.stringify(event)}`);
  }

  publishToDashboard(event);

  return event;
}

module.exports = {
  normalizeTradeEvent,
  formatConciseTradeEvent,
  emitTradeEvent,
  VERBOSE_TRADE_LOGS,
  TRADE_LOG_JSON,
};
