/**
 * Public WebSocket feeds for BTC spot prices (Coinbase, Kraken).
 * Binance stays in api/feeds_runtime.js; buffers share the same PriceBufferStore keys.
 */

const RECONNECT_MS = 2000;
const WS = globalThis.WebSocket || require('ws');

const ALT_SOURCES = ['coinbase', 'kraken'];

/** @type {Record<string, { price: number|null, updatedAt: number|null, sourceUpdatedAt: number|null, latencyMs: number|null, connected: boolean }>} */
const states = Object.fromEntries(
  ALT_SOURCES.map((s) => [s, { price: null, updatedAt: null, sourceUpdatedAt: null, latencyMs: null, connected: false }])
);

function recordLatency(streamKey, opts) {
  try {
    require('../monitoring/latency').recordStreamLatency(streamKey, opts);
  } catch (_) {}
}

function bufferKey(source) {
  return source === 'binance' ? '__btc__' : `__btc_${source}__`;
}

function getExchangeState(source) {
  if (source === 'binance') {
    const { getBinanceState } = require('../api/feeds_runtime');
    const s = getBinanceState();
    return {
      price: s.price,
      updatedAt: s.updatedAt,
      sourceUpdatedAt: s.sourceUpdatedAt,
      latencyMs: s.latencyMs,
      connected: Number.isFinite(s.price) && s.updatedAt && Date.now() - s.updatedAt < 30_000,
    };
  }
  return states[source] || { price: null, updatedAt: null, connected: false };
}

function isExchangeConnected(source) {
  const s = getExchangeState(source);
  return Boolean(s.connected);
}

function connectCoinbase(onTick) {
  const url = process.env.COINBASE_WS_URL || 'wss://ws-feed.exchange.coinbase.com';
  let ws = null;

  function connect() {
    try {
      ws = new WS(url);
    } catch (e) {
      console.warn('[Coinbase WS] connect failed:', e.message);
      setTimeout(connect, RECONNECT_MS);
      return;
    }

    ws.onopen = () => {
      states.coinbase.connected = true;
      try {
        ws.send(JSON.stringify({
          type: 'subscribe',
          product_ids: ['BTC-USD'],
          channels: ['ticker'],
        }));
      } catch (_) {}
    };

    ws.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch (_) {
        return;
      }
      if (data.type === 'subscriptions') return;
      if (data.type !== 'ticker' || data.product_id !== 'BTC-USD') return;
      const receivedAt = Date.now();
      const price = parseFloat(data.price);
      const sourceTs = data.time ? Date.parse(data.time) : receivedAt;
      const latencyMs = receivedAt - sourceTs;
      states.coinbase = {
        price,
        updatedAt: receivedAt,
        sourceUpdatedAt: sourceTs,
        latencyMs,
        connected: true,
      };
      recordLatency('coinbase_ws', { sourceTs, receivedTs: receivedAt, meta: { price } });
      onTick('coinbase', { price, symbol: 'BTC-USD', ts_ms: sourceTs, receivedAt, latencyMs });
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      states.coinbase.connected = false;
      setTimeout(connect, RECONNECT_MS);
    };
  }

  connect();
  return () => ws?.close();
}

function connectKraken(onTick) {
  const url = process.env.KRAKEN_WS_URL || 'wss://ws.kraken.com';
  let ws = null;

  function connect() {
    try {
      ws = new WS(url);
    } catch (e) {
      console.warn('[Kraken WS] connect failed:', e.message);
      setTimeout(connect, RECONNECT_MS);
      return;
    }

    ws.onopen = () => {
      states.kraken.connected = true;
      try {
        ws.send(JSON.stringify({
          event: 'subscribe',
          pair: ['XBT/USD'],
          subscription: { name: 'ticker' },
        }));
      } catch (_) {}
    };

    ws.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch (_) {
        return;
      }
      if (data?.event === 'heartbeat' || data?.event === 'systemStatus' || data?.event === 'subscriptionStatus') {
        if (data?.event === 'subscriptionStatus' && data?.status === 'subscribed') {
          states.kraken.connected = true;
        }
        return;
      }
      if (!Array.isArray(data) || data[2] !== 'ticker') return;
      const ticker = data[1];
      const price = parseFloat(ticker?.c?.[0]);
      if (!Number.isFinite(price)) return;
      const receivedAt = Date.now();
      const latencyMs = null;
      states.kraken = {
        price,
        updatedAt: receivedAt,
        sourceUpdatedAt: receivedAt,
        latencyMs,
        connected: true,
      };
      recordLatency('kraken_ws', { sourceTs: receivedAt, receivedTs: receivedAt, meta: { price } });
      onTick('kraken', { price, symbol: 'XBT/USD', ts_ms: receivedAt, receivedAt, latencyMs });
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      states.kraken.connected = false;
      setTimeout(connect, RECONNECT_MS);
    };
  }

  connect();
  return () => ws?.close();
}

/**
 * @param {(source: string, tick: { price: number, symbol: string, ts_ms: number, receivedAt: number, latencyMs: number|null }) => void} onTick
 */
function startAltExchangeFeeds(onTick) {
  const stops = [
    connectCoinbase(onTick),
    connectKraken(onTick),
  ];
  console.log('[Feeds] alt exchange WS: Coinbase BTC-USD, Kraken XBT/USD');
  return () => stops.forEach((stop) => { try { stop?.(); } catch (_) {} });
}

module.exports = {
  ALT_SOURCES,
  ALL_SOURCES: ['binance', ...ALT_SOURCES],
  bufferKey,
  getExchangeState,
  isExchangeConnected,
  startAltExchangeFeeds,
};
