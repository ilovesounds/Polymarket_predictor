/**
 * L2 market cache in Redis (Gamma fetch is L3; in-process map is L1 in polymarket_runtime).
 */

const { getRedis, isRedisRequested } = require('./redis');

const ACTIVE_IDS_KEY = 'market:active_ids';
const MARKET_KEY_PREFIX = 'market:';
const DEFAULT_TTL_SEC = 300;

function marketKey(conditionId) {
  return `${MARKET_KEY_PREFIX}${conditionId}`;
}

/**
 * @param {string} conditionId
 * @returns {Promise<object|null>}
 */
async function getMarket(conditionId) {
  const id = String(conditionId || '').trim();
  if (!id || !isRedisRequested()) return null;
  const r = await getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(marketKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} market
 * @param {number} [ttlSec=300]
 */
async function setMarket(market, ttlSec = DEFAULT_TTL_SEC) {
  const id = market?.conditionId;
  if (!id || !isRedisRequested()) return;
  const r = await getRedis();
  if (!r) return;
  try {
    const key = marketKey(id);
    const pipe = r.multi();
    pipe.set(key, JSON.stringify(market), { EX: Math.max(30, ttlSec) });
    pipe.sAdd(ACTIVE_IDS_KEY, id);
    pipe.expire(ACTIVE_IDS_KEY, Math.max(60, ttlSec * 2));
    await pipe.exec();
  } catch (_) {}
}

/**
 * Pipeline GET for all active condition ids in Redis.
 * @returns {Promise<object[]>}
 */
async function getCachedActiveMarkets() {
  if (!isRedisRequested()) return [];
  const r = await getRedis();
  if (!r) return [];
  try {
    const ids = await r.sMembers(ACTIVE_IDS_KEY);
    if (!ids?.length) return [];
    const pipe = r.multi();
    for (const id of ids) pipe.get(marketKey(id));
    const results = await pipe.exec();
    const markets = [];
    for (const row of results || []) {
      const raw = row?.[1] ?? row;
      if (typeof raw !== 'string' || !raw) continue;
      try {
        markets.push(JSON.parse(raw));
      } catch (_) {}
    }
    return markets.filter((m) => m?.conditionId);
  } catch (_) {
    return [];
  }
}

/**
 * Cache many markets after a Gamma fetch.
 * @param {object[]} markets
 */
async function cacheMarkets(markets, ttlSec = DEFAULT_TTL_SEC) {
  if (!Array.isArray(markets) || !markets.length) return;
  await Promise.all(markets.map((m) => setMarket(m, ttlSec)));
}

module.exports = {
  ACTIVE_IDS_KEY,
  getMarket,
  setMarket,
  getCachedActiveMarkets,
  cacheMarkets,
};
