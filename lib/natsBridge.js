/**
 * Reusable NATS client: reconnect/backoff, JSON pub/sub, dedup helper.
 */
const { connect: natsConnect, StringCodec } = require('nats');
const { parseJson } = require('./nats/schemas');

const sc = StringCodec();

const DEFAULT_URL = process.env.NATS_URL || 'nats://127.0.0.1:4222';
const DEFAULT_MAX_RECONNECT_MS = Number(process.env.NATS_RECONNECT_MAX_MS || 30_000);
const DEFAULT_CONNECT_TIMEOUT_MS = Number(process.env.NATS_CONNECT_TIMEOUT_MS || 8_000);

function createDeduper({ ttlMs = Number(process.env.NATS_DEDUP_MS || 400), maxKeys = 2000 } = {}) {
  const seen = new Map();

  function prune() {
    const cutoff = Date.now() - ttlMs;
    for (const [k, t] of seen) {
      if (t < cutoff) seen.delete(k);
    }
    if (seen.size > maxKeys) {
      const drop = seen.size - maxKeys;
      let i = 0;
      for (const k of seen.keys()) {
        seen.delete(k);
        if (++i >= drop) break;
      }
    }
  }

  return {
    isDuplicate(key) {
      if (!key) return false;
      prune();
      const now = Date.now();
      if (seen.has(key)) return true;
      seen.set(key, now);
      return false;
    },
    keyFor(subject, msg) {
      const ts = msg?.ts || msg?.timestamp || 0;
      if (subject === 'feeds.binance.price') {
        const p = msg?.price;
        return `${subject}:${Math.round((p || 0) * 100)}`;
      }
      if (subject === 'feeds.polymarket.price') {
        const cid = msg?.market?.conditionId || '';
        const y = msg?.yesPrice;
        const n = msg?.noPrice;
        return `${subject}:${cid}:${Math.round((y || 0) * 1000)}:${Math.round((n || 0) * 1000)}`;
      }
      if (subject === 'feeds.polymarket.orderbook') {
        return `${subject}:${msg?.market?.conditionId || ''}:${ts}`;
      }
      if (subject === 'feeds.polymarket.trades') {
        return `${subject}:${msg?.tradeKey || `${msg?.side}:${msg?.size}:${msg?.price}:${ts}`}`;
      }
      if (subject === 'feeds.polymarket.markets') {
        return `${subject}:${msg?.selectedMode || ''}:${(msg?.markets || []).length}`;
      }
      if (subject === 'bot.status') {
        return `${subject}:${msg?.running}:${msg?.cash ?? msg?.bankroll}:${Math.floor(ts / 2000)}`;
      }
      if (subject === 'bot.events') {
        if (msg?.type === 'log') {
          return `${subject}:log:${msg?.message || ''}`.slice(0, 200);
        }
        return `${subject}:${msg?.type}:${msg?.tradeId || msg?.marketId || ''}:${ts}`;
      }
      return `${subject}:${JSON.stringify(msg).slice(0, 120)}`;
    },
  };
}

function createNatsBridge(options = {}) {
  const url = options.url || DEFAULT_URL;
  const name = options.name || 'polymarket-bridge';
  const maxReconnectMs = options.maxReconnectMs || DEFAULT_MAX_RECONNECT_MS;
  const connectTimeoutMs = options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
  const deduper = options.deduper || createDeduper(options.dedup || {});

  let nc = null;
  let connectPromise = null;
  let closed = false;
  const subs = [];
  const statusListeners = new Set();

  function emitStatus(patch) {
    const status = { connected: Boolean(nc && !nc.isClosed()), url, name, ...patch };
    for (const fn of statusListeners) {
      try { fn(status); } catch (_) {}
    }
  }

  async function connectOnce() {
    if (closed) throw new Error('NATS bridge closed');

    const client = await natsConnect({
      servers: url,
      name,
      timeout: connectTimeoutMs,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 500,
      reconnectJitter: 200,
      reconnectJitterTLS: 200,
      reconnectDelayHandler: () => {
        const base = 500;
        const attempt = nc?.info?.reconnects || 0;
        return Math.min(maxReconnectMs, base * (2 ** Math.min(attempt, 6)));
      },
    });

    nc = client;
    closed = false;

    (async () => {
      for await (const s of nc.status()) {
        if (s.type === 'disconnect') emitStatus({ lastEvent: 'disconnect' });
        if (s.type === 'reconnect') emitStatus({ lastEvent: 'reconnect' });
        if (s.type === 'error') emitStatus({ lastEvent: 'error', error: s.data?.message || String(s.data) });
      }
    })().catch(() => {});

    emitStatus({ lastEvent: 'connect' });
    return nc;
  }

  async function connect() {
    if (closed) throw new Error('NATS bridge closed');
    if (nc && !nc.isClosed()) return nc;
    if (connectPromise) return connectPromise;

    connectPromise = connectOnce()
      .catch((err) => {
        nc = null;
        emitStatus({ lastEvent: 'error', error: err?.message || String(err) });
        throw err;
      })
      .finally(() => {
        connectPromise = null;
      });

    return connectPromise;
  }

  async function publish(subject, payload) {
    const client = await connect();
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    client.publish(subject, sc.encode(body));
  }

  async function subscribe(subject, handler, opts = {}) {
    const client = await connect();
    const sub = client.subscribe(subject, opts);
    subs.push(sub);

    (async () => {
      for await (const m of sub) {
        let msg;
        try {
          msg = parseJson(sc.decode(m.data));
        } catch (_) {
          continue;
        }
        if (opts.dedup !== false) {
          const key = deduper.keyFor(m.subject, msg);
          if (deduper.isDuplicate(key)) continue;
        }
        try {
          await handler(msg, m.subject);
        } catch (_) {}
      }
    })().catch(() => {});

    return sub;
  }

  async function close() {
    closed = true;
    connectPromise = null;
    for (const s of subs) {
      try { s.unsubscribe(); } catch (_) {}
    }
    subs.length = 0;
    if (nc && !nc.isClosed()) {
      await nc.drain().catch(() => nc.close());
    }
    nc = null;
    emitStatus({ lastEvent: 'close' });
  }

  function onStatus(fn) {
    statusListeners.add(fn);
    return () => statusListeners.delete(fn);
  }

  return {
    connect,
    publish,
    subscribe,
    close,
    onStatus,
    get connected() {
      return Boolean(nc && !nc.isClosed());
    },
    createDeduper,
  };
}

module.exports = {
  createNatsBridge,
  createDeduper,
  DEFAULT_URL,
};
