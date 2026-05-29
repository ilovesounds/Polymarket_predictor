/**
 * Layer-1 price history in Redis sorted sets (5m window, 360s key TTL).
 */

const { getRedis, isRedisRequested } = require('./redis');

const TRIM_MS = 5 * 60 * 1000;
const KEY_TTL_SEC = 360;

function priceKey(tokenId) {
  return `price:${tokenId}`;
}

/**
 * @param {string} tokenId — conditionId, token id, or __btc__
 * @param {number} price
 * @param {number} [ts] — ms epoch
 */
async function pushPrice(tokenId, price, ts = Date.now()) {
  if (!tokenId || !Number.isFinite(price) || !isRedisRequested()) return;
  const r = await getRedis();
  if (!r) return;

  const score = Number(ts) || Date.now();
  const member = `${price}:${score}`;
  const key = priceKey(tokenId);
  const cutoff = score - TRIM_MS;

  try {
    const pipe = r.multi();
    pipe.zAdd(key, [{ score, value: member }]);
    pipe.zRemRangeByScore(key, 0, cutoff);
    pipe.expire(key, KEY_TTL_SEC);
    await pipe.exec();
  } catch (_) {}
}

/**
 * @param {string} tokenId
 * @param {number} [windowSec=60]
 * @returns {Promise<Array<{ t: number, p: number }>>}
 */
async function getPriceHistory(tokenId, windowSec = 60) {
  if (!tokenId || !isRedisRequested()) return [];
  const r = await getRedis();
  if (!r) return [];

  const now = Date.now();
  const minScore = now - Math.max(1, windowSec) * 1000;
  const key = priceKey(tokenId);

  try {
    const members = await r.zRangeByScore(key, minScore, now);
    return members
      .map((m) => {
        const idx = m.lastIndexOf(':');
        if (idx <= 0) return null;
        const p = parseFloat(m.slice(0, idx));
        const t = parseInt(m.slice(idx + 1), 10);
        if (!Number.isFinite(p) || !Number.isFinite(t)) return null;
        return { t, p };
      })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);
  } catch (_) {
    return [];
  }
}

module.exports = {
  pushPrice,
  getPriceHistory,
  priceKey,
};
