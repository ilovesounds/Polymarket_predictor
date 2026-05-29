/**
 * Short-TTL orderbook cache (hot path for depth / enrichment).
 */

const { getRedis, isRedisRequested } = require('./redis');

const KEY_PREFIX = 'orderbook:';
const DEFAULT_TTL_SEC = 5;

function obKey(tokenId) {
  return `${KEY_PREFIX}${tokenId}`;
}

/**
 * @param {string} tokenId
 * @returns {Promise<{ bids: Array, asks: Array }|null>}
 */
async function getOrderbook(tokenId) {
  const id = String(tokenId || '').trim();
  if (!id || !isRedisRequested()) return null;
  const r = await getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(obKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} tokenId
 * @param {{ bids: Array, asks: Array }} ob
 * @param {number} [ttlSec=5]
 */
async function setOrderbook(tokenId, ob, ttlSec = DEFAULT_TTL_SEC) {
  const id = String(tokenId || '').trim();
  if (!id || !ob || !isRedisRequested()) return;
  const r = await getRedis();
  if (!r) return;
  try {
    await r.set(obKey(id), JSON.stringify(ob), { EX: Math.max(1, ttlSec) });
  } catch (_) {}
}

module.exports = {
  getOrderbook,
  setOrderbook,
};
