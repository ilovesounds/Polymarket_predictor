/**
 * JSON message schemas (v1) for NATS subjects.
 * Rust publishers should emit the same envelope: { v, ts, ...payload }.
 */
const SCHEMA_VERSION = 1;

function nowTs() {
  return Date.now();
}

function baseEnvelope(source, type, extra = {}) {
  return {
    v: SCHEMA_VERSION,
    ts: nowTs(),
    source,
    type,
    ...extra,
  };
}

function binancePrice({ price, symbol = 'BTCUSDT', ts } = {}) {
  return baseEnvelope('binance', 'price', {
    ts: ts || nowTs(),
    symbol,
    price: Number(price),
  });
}

function polymarketPrice({
  yesPrice,
  noPrice,
  side,
  via = 'ws',
  market,
  ts,
} = {}) {
  return baseEnvelope('polymarket', 'price', {
    ts: ts || nowTs(),
    yesPrice: Number.isFinite(yesPrice) ? yesPrice : null,
    noPrice: Number.isFinite(noPrice) ? noPrice : null,
    side: side || 'snapshot',
    via,
    market: market || null,
  });
}

function polymarketOrderbook({ market, yes, no, via = 'nats', ts } = {}) {
  return baseEnvelope('polymarket', 'orderbook', {
    ts: ts || nowTs(),
    market,
    yes,
    no,
    via,
  });
}

function polymarketTrade({
  side,
  size,
  price,
  usdc,
  ts_ms,
  clobSide,
  taker,
  market,
  via = 'clob_ws',
  tradeKey,
  ts,
} = {}) {
  return baseEnvelope('polymarket', 'trade', {
    ts: ts_ms || ts || nowTs(),
    ts_ms: ts_ms || ts || nowTs(),
    side,
    size: Number(size),
    price: Number(price),
    usdc: Number.isFinite(usdc) ? usdc : (Number(size) * Number(price)),
    clobSide: clobSide || null,
    taker: taker ?? null,
    market: market || null,
    via,
    tradeKey: tradeKey || null,
  });
}

function polymarketMarkets({ markets, selectedMode, message, ts } = {}) {
  return baseEnvelope('polymarket', 'markets', {
    ts: ts || nowTs(),
    selectedMode,
    markets: markets || [],
    message: message || null,
  });
}

function botStatus({
  running,
  pid,
  mode = 'paper',
  strategyId,
  cash,
  portfolio,
  startedAt,
  stoppedAt,
  lastExitCode,
  binanceConnected,
  polymarketConnected,
  selectedPolyMode,
  clientCount,
  ts,
} = {}) {
  return baseEnvelope('bot', 'status', {
    ts: ts || nowTs(),
    running: Boolean(running),
    pid: pid ?? null,
    mode,
    strategyId: strategyId || null,
    cash: Number.isFinite(cash) ? cash : null,
    portfolio: Number.isFinite(portfolio) ? portfolio : null,
    startedAt: startedAt ?? null,
    stoppedAt: stoppedAt ?? null,
    lastExitCode: lastExitCode ?? null,
    binanceConnected: typeof binanceConnected === 'boolean' ? binanceConnected : undefined,
    polymarketConnected: typeof polymarketConnected === 'boolean' ? polymarketConnected : undefined,
    selectedPolyMode: selectedPolyMode || undefined,
    clientCount: Number.isFinite(clientCount) ? clientCount : undefined,
  });
}

function botEvent(event = {}) {
  const { type, ts, ...rest } = event;
  return baseEnvelope('bot', type || 'event', {
    ts: ts || nowTs(),
    ...rest,
  });
}

function botControl({ command, strategyId, mode, requestId, ts } = {}) {
  return baseEnvelope('bot', 'control', {
    ts: ts || nowTs(),
    command,
    strategyId: strategyId || null,
    mode: mode || null,
    requestId: requestId || null,
  });
}

/**
 * Map a NATS payload to the dashboard WebSocket wire format (browser unchanged).
 */
function toDashboardWire(subject, msg) {
  if (!msg || typeof msg !== 'object') return null;
  const ts = msg.ts || msg.timestamp || Date.now();

  if (subject === 'feeds.binance.price' || (msg.source === 'binance' && msg.type === 'price')) {
    return {
      source: 'binance',
      type: 'price',
      price: msg.price,
      symbol: msg.symbol || 'BTCUSDT',
      timestamp: ts,
    };
  }

  if (subject === 'feeds.polymarket.price' || (msg.source === 'polymarket' && msg.type === 'price')) {
    return {
      source: 'polymarket',
      type: 'price',
      yesPrice: msg.yesPrice ?? null,
      noPrice: msg.noPrice ?? null,
      side: msg.side,
      via: msg.via,
      market: msg.market,
      timestamp: ts,
    };
  }

  if (subject === 'feeds.polymarket.orderbook' || (msg.source === 'polymarket' && msg.type === 'orderbook')) {
    return {
      source: 'polymarket',
      type: 'orderbook',
      market: msg.market,
      yes: msg.yes,
      no: msg.no,
      via: msg.via,
      timestamp: ts,
    };
  }

  if (subject === 'feeds.polymarket.trades' || (msg.source === 'polymarket' && msg.type === 'trade')) {
    const tsMs = msg.ts_ms || msg.ts || ts;
    return {
      source: 'polymarket',
      type: 'trade',
      side: msg.side,
      size: msg.size,
      price: msg.price,
      usdc: msg.usdc,
      ts_ms: tsMs,
      clobSide: msg.clobSide,
      taker: msg.taker ?? null,
      market: msg.market,
      via: msg.via,
      tradeKey: msg.tradeKey,
      timestamp: tsMs,
    };
  }

  if (subject === 'feeds.polymarket.markets' || (msg.source === 'polymarket' && msg.type === 'markets')) {
    return {
      source: 'polymarket',
      type: 'markets',
      markets: msg.markets || [],
      selectedMode: msg.selectedMode,
      message: msg.message,
      timestamp: ts,
    };
  }

  if (subject === 'bot.status' || (msg.source === 'bot' && msg.type === 'status')) {
    return {
      source: 'system',
      type: 'status',
      timestamp: ts,
      binanceConnected: msg.binanceConnected,
      polymarketConnected: msg.polymarketConnected,
      selectedPolyMode: msg.selectedPolyMode,
      clientCount: msg.clientCount,
      bot: {
        running: msg.running,
        pid: msg.pid,
        mode: msg.mode,
        strategyId: msg.strategyId,
        cash: msg.cash ?? msg.bankroll,
        portfolio: msg.portfolio,
        startedAt: msg.startedAt,
        stoppedAt: msg.stoppedAt,
        lastExitCode: msg.lastExitCode,
      },
    };
  }

  if (subject === 'bot.events' || msg.source === 'bot') {
    const wire = {
      source: 'bot',
      timestamp: ts,
      type: msg.type === 'control' ? msg.type : (msg.type || msg.eventType || 'event'),
      ...msg,
    };
    delete wire.v;
    if (wire.type === 'log') {
      return {
        source: 'bot',
        type: 'log',
        level: msg.level || 'info',
        message: msg.message || msg.detail || '',
        timestamp: ts,
      };
    }
    if (Number.isFinite(msg.cashAfter) || Number.isFinite(msg.bankrollAfter)
      || Number.isFinite(msg.cash) || Number.isFinite(msg.bankroll)) {
      wire.cashAfter = msg.cashAfter ?? msg.bankrollAfter ?? msg.cash ?? msg.bankroll;
    }
    return wire;
  }

  return null;
}

function parseJson(data) {
  const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
  return JSON.parse(raw);
}

module.exports = {
  SCHEMA_VERSION,
  binancePrice,
  polymarketPrice,
  polymarketOrderbook,
  polymarketTrade,
  polymarketMarkets,
  botStatus,
  botEvent,
  botControl,
  toDashboardWire,
  parseJson,
};
