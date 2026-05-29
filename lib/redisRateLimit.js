/**
 * Sliding-window order rate limit via Redis INCR.
 */

const { getRedis, isRedisRequested } = require('./redis');

function isRateLimitEnabled() {
  return isRedisRequested()
    && String(process.env.REDIS_RATE_LIMIT || '').toLowerCase() === 'true';
}

/**
 * @param {number} [maxOrders=10]
 * @param {number} [windowSec=60]
 * @returns {Promise<{ allowed: boolean, count: number, limit: number }>}
 */
async function checkRateLimit(maxOrders = 10, windowSec = 60) {
  if (!isRateLimitEnabled()) {
    return { allowed: true, count: 0, limit: maxOrders };
  }
  const r = await getRedis();
  if (!r) return { allowed: true, count: 0, limit: maxOrders };

  const windowId = Math.floor(Date.now() / (windowSec * 1000));
  const key = `rl:orders:${windowId}`;

  try {
    const count = await r.incr(key);
    if (count === 1) await r.expire(key, windowSec + 5);
    return {
      allowed: count <= maxOrders,
      count,
      limit: maxOrders,
    };
  } catch (_) {
    return { allowed: true, count: 0, limit: maxOrders };
  }
}

module.exports = {
  checkRateLimit,
  isRateLimitEnabled,
};
