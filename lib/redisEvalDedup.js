/**
 * Per-cycle evaluation dedup (avoid re-evaluating same market many times per WS burst).
 */

const { getRedis, isRedisRequested } = require('./redis');

const SET_KEY = 'evaled_this_cycle';
const EXPIRE_SEC = 30;

/** In-process fallback when Redis is off or unreachable */
const localEvaluated = new Set();
let localEvalTimer = null;

function touchLocalEvalSet() {
  if (localEvalTimer) return;
  localEvalTimer = setTimeout(() => {
    localEvaluated.clear();
    localEvalTimer = null;
  }, EXPIRE_SEC * 1000);
}

/**
 * @param {string} conditionId
 * @returns {Promise<boolean>}
 */
async function alreadyEvaluated(conditionId) {
  const id = String(conditionId || '').trim();
  if (!id) return false;
  if (!isRedisRequested()) return localEvaluated.has(id);

  const r = await getRedis();
  if (!r) return localEvaluated.has(id);
  try {
    return Boolean(await r.sIsMember(SET_KEY, id));
  } catch (_) {
    return localEvaluated.has(id);
  }
}

/**
 * @param {string} conditionId
 */
async function markEvaluated(conditionId) {
  const id = String(conditionId || '').trim();
  if (!id) return;

  const r = isRedisRequested() ? await getRedis() : null;
  if (r) {
    try {
      const pipe = r.multi();
      pipe.sAdd(SET_KEY, id);
      pipe.expire(SET_KEY, EXPIRE_SEC);
      await pipe.exec();
      return;
    } catch (_) {}
  }

  localEvaluated.add(id);
  touchLocalEvalSet();
}

module.exports = {
  alreadyEvaluated,
  markEvaluated,
};
