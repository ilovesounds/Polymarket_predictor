/**
 * Poll orderbook depth after bot entry to measure update lag vs orderbookDepthAtEntry.
 */

const { getLiquidityDepth } = require('../api/polymarket_runtime');
const { recordPostEntryDepthPoll } = require('./latency');

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_MAX_POLLS = 20;

function publishPoll(tradeId, poll) {
  if (process.env.ENABLE_DASHBOARD_FEED === 'false') return;
  const port = process.env.DASHBOARD_PORT || 3847;
  fetch(`http://127.0.0.1:${port}/api/latency/trade-poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tradeId, poll }),
  }).catch(() => {});
}

/**
 * @param {{ tradeId: string, tokenId: string, depthAtEntry: number, entryAt: number, intervalMs?: number, maxPolls?: number }} opts
 */
function watchPostEntryDepth(opts) {
  const {
    tradeId,
    tokenId,
    depthAtEntry,
    entryAt,
    intervalMs = DEFAULT_INTERVAL_MS,
    maxPolls = DEFAULT_MAX_POLLS,
  } = opts;

  if (!tradeId || !tokenId || !Number.isFinite(depthAtEntry) || !Number.isFinite(entryAt)) return;

  let polls = 0;
  const timer = setInterval(async () => {
    polls += 1;
    const pollStart = Date.now();
    try {
      const depth = await getLiquidityDepth(tokenId);
      const pollEnd = Date.now();
      const msSinceEntry = pollEnd - entryAt;
      const depthDelta = Number.isFinite(depth) ? depth - depthAtEntry : null;
      recordPostEntryDepthPoll(tradeId, {
        at: pollEnd,
        depth,
        msSinceEntry,
        depthDelta,
        rttMs: pollEnd - pollStart,
      });
      publishPoll(tradeId, {
        at: pollEnd,
        depth,
        msSinceEntry,
        depthDelta,
        rttMs: pollEnd - pollStart,
      });
    } catch (_) {}

    if (polls >= maxPolls) clearInterval(timer);
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { watchPostEntryDepth };
