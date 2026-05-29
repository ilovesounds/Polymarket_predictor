/**
 * Lazy Redis singleton (node-redis v4+). Graceful fallback when unavailable.
 * Enable with USE_REDIS=true or set REDIS_URL (auto-detect).
 */

const redis = require('redis');

let client = null;
let connectPromise = null;
let redisAvailable = false;
let redisDisabled = false;
let warnedUnavailable = false;

function isRedisRequested() {
  const flag = String(process.env.USE_REDIS || '').trim().toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'no') return false;
  if (flag === 'true' || flag === '1' || flag === 'yes') return true;
  return Boolean(process.env.REDIS_URL);
}

function warnUnavailable(err) {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  const msg = err?.message || String(err || 'unavailable');
  console.warn(`[Redis] unavailable, using file/memory fallback: ${msg}`);
}

/**
 * @returns {Promise<import('redis').RedisClientType|null>}
 */
async function getRedis() {
  if (redisDisabled || !isRedisRequested()) return null;
  if (client?.isReady) return client;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      const url = process.env.REDIS_URL || 'redis://localhost:6379';
      const c = redis.createClient({ url });
      c.on('error', (err) => {
        if (!redisAvailable) warnUnavailable(err);
      });
      await c.connect();
      client = c;
      redisAvailable = true;
      const safeUrl = url.replace(/:([^:@/]+)@/, ':***@');
      console.log(`[Redis] connected (${safeUrl})`);
      return client;
    } catch (err) {
      redisDisabled = true;
      redisAvailable = false;
      client = null;
      warnUnavailable(err);
      return null;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

function isRedisReady() {
  return Boolean(redisAvailable && client?.isReady);
}

async function closeRedis() {
  if (client?.isOpen) {
    await client.quit().catch(() => {});
  }
  client = null;
  redisAvailable = false;
  connectPromise = null;
}

module.exports = {
  getRedis,
  isRedisReady,
  isRedisRequested,
  closeRedis,
};
