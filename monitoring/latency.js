/**
 * Stream + trade-depth latency tracker with rolling stats.
 */

const MAX_SAMPLES = 300;
const MAX_TRADE_EVENTS = 50;

const STREAM_KEYS = [
  'binance_ws',
  'coinbase_ws',
  'kraken_ws',
  'chainlink_oracle_age',
  'chainlink_poll_rtt',
  'poly_ws_price',
  'poly_ws_trade',
  'poly_midpoint_rest',
  'poly_orderbook_rest',
  'poly_orderbook_poll',
];

/** @type {Record<string, { samples: number[], last: object|null }>} */
const streams = Object.fromEntries(STREAM_KEYS.map((k) => [k, { samples: [], last: null }]));

/** @type {Array<object>} */
const tradeDepthEvents = [];

let snapshotListeners = new Set();
let lastBroadcastAt = 0;
const BROADCAST_THROTTLE_MS = 1500;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(samples) {
  if (!samples.length) {
    return { count: 0, avg: null, min: null, max: null, p50: null, p95: null, latest: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    count: sorted.length,
    avg: Math.round(sum / sorted.length),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    latest: sorted[sorted.length - 1],
  };
}

/**
 * @param {string} streamKey
 * @param {{ sourceTs?: number, receivedTs?: number, latencyMs?: number, meta?: object }} opts
 */
function recordStreamLatency(streamKey, opts = {}) {
  if (!streams[streamKey]) return null;

  const receivedTs = Number.isFinite(opts.receivedTs) ? opts.receivedTs : Date.now();
  const sourceTs = Number.isFinite(opts.sourceTs) ? opts.sourceTs : receivedTs;
  let latencyMs = Number.isFinite(opts.latencyMs) ? opts.latencyMs : receivedTs - sourceTs;
  if (!Number.isFinite(latencyMs) || latencyMs < 0) latencyMs = 0;
  if (latencyMs > 600_000) return null;

  const bucket = streams[streamKey];
  bucket.samples.push(Math.round(latencyMs));
  if (bucket.samples.length > MAX_SAMPLES) bucket.samples.shift();

  const entry = {
    stream: streamKey,
    latencyMs: Math.round(latencyMs),
    sourceTs,
    receivedTs,
    at: receivedTs,
    meta: opts.meta || null,
  };
  bucket.last = entry;
  maybeBroadcast();
  return entry;
}

/**
 * @param {object} event
 */
function recordTradeDepthPipeline(event) {
  const row = {
    tradeId: event.tradeId || null,
    marketId: event.marketId || null,
    decidedAt: event.decidedAt || null,
    depthFetchStart: event.depthFetchStart || null,
    depthFetchEnd: event.depthFetchEnd || null,
    depthSetAt: event.depthSetAt || null,
    orderbookDepthAtEntry: event.orderbookDepthAtEntry ?? null,
    depthFetchMs: null,
    decisionToDepthMs: null,
    postEntryPolls: [],
    recordedAt: Date.now(),
  };

  if (Number.isFinite(row.depthFetchStart) && Number.isFinite(row.depthFetchEnd)) {
    row.depthFetchMs = row.depthFetchEnd - row.depthFetchStart;
  }
  if (Number.isFinite(row.decidedAt) && Number.isFinite(row.depthSetAt)) {
    row.decisionToDepthMs = row.depthSetAt - row.decidedAt;
  }

  tradeDepthEvents.unshift(row);
  if (tradeDepthEvents.length > MAX_TRADE_EVENTS) tradeDepthEvents.length = MAX_TRADE_EVENTS;
  maybeBroadcast();
  return row;
}

function recordPostEntryDepthPoll(tradeId, poll) {
  const row = tradeDepthEvents.find((t) => t.tradeId === tradeId);
  if (!row) return null;
  row.postEntryPolls.push({
    at: poll.at || Date.now(),
    depth: poll.depth ?? null,
    msSinceEntry: poll.msSinceEntry ?? null,
    depthDelta: poll.depthDelta ?? null,
    rttMs: poll.rttMs ?? null,
  });
  if (row.postEntryPolls.length > 24) row.postEntryPolls.shift();
  maybeBroadcast();
  return row;
}

function ingestTradePoll(tradeId, poll) {
  if (!tradeId) return null;
  return recordPostEntryDepthPoll(tradeId, poll);
}

function getStreamStats() {
  const out = {};
  for (const key of STREAM_KEYS) {
    out[key] = {
      ...summarize(streams[key].samples),
      last: streams[key].last,
    };
  }
  return out;
}

function getTradeDepthSummary() {
  const withTiming = tradeDepthEvents.filter((t) => Number.isFinite(t.decisionToDepthMs));
  const depthFetch = withTiming
    .map((t) => t.depthFetchMs)
    .filter(Number.isFinite);
  const decisionToDepth = withTiming
    .map((t) => t.decisionToDepthMs)
    .filter(Number.isFinite);

  const firstPollDeltas = tradeDepthEvents
    .map((t) => {
      const firstChange = t.postEntryPolls.find((p) => Number.isFinite(p.depthDelta) && p.depthDelta !== 0);
      return firstChange ? firstChange.msSinceEntry : null;
    })
    .filter(Number.isFinite);

  return {
    count: tradeDepthEvents.length,
    depthFetch: summarize(depthFetch),
    decisionToDepth: summarize(decisionToDepth),
    firstDepthChange: summarize(firstPollDeltas),
    recent: tradeDepthEvents.slice(0, 12),
  };
}

function getSnapshot() {
  return {
    timestamp: Date.now(),
    streams: getStreamStats(),
    tradeDepth: getTradeDepthSummary(),
  };
}

function onSnapshot(fn) {
  snapshotListeners.add(fn);
  return () => snapshotListeners.delete(fn);
}

function maybeBroadcast() {
  const now = Date.now();
  if (now - lastBroadcastAt < BROADCAST_THROTTLE_MS) return;
  lastBroadcastAt = now;
  const snap = getSnapshot();
  for (const fn of snapshotListeners) {
    try { fn(snap); } catch (_) {}
  }
}

function reset() {
  for (const key of STREAM_KEYS) {
    streams[key].samples = [];
    streams[key].last = null;
  }
  tradeDepthEvents.length = 0;
}

module.exports = {
  STREAM_KEYS,
  recordStreamLatency,
  recordTradeDepthPipeline,
  recordPostEntryDepthPoll,
  ingestTradePoll,
  getSnapshot,
  getStreamStats,
  getTradeDepthSummary,
  onSnapshot,
  reset,
  summarize,
};
