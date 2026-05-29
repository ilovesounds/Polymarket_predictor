/**
 * Bot profile + Strategy Lab presets in Redis (JSON blobs).
 */

const { getRedis, isRedisRequested } = require('./redis');

const KEYS = {
  BOT_PROFILE: 'bot:profile',
  LAB_PRESETS: 'lab:presets',
  LAB_ACTIVE_PRESET: 'lab:active_preset',
  CASH_ADJUSTMENTS: 'cash:adjustments',
};

async function redisGetJson(key) {
  if (!isRedisRequested()) return null;
  const r = await getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

async function redisSetJson(key, data, ttlSec = null) {
  if (!isRedisRequested()) return false;
  const r = await getRedis();
  if (!r) return false;
  try {
    const payload = JSON.stringify(data);
    if (ttlSec && ttlSec > 0) {
      await r.set(key, payload, { EX: ttlSec });
    } else {
      await r.set(key, payload);
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function getBotProfileFromRedis() {
  return redisGetJson(KEYS.BOT_PROFILE);
}

async function setBotProfileInRedis(profile) {
  return redisSetJson(KEYS.BOT_PROFILE, profile);
}

async function getPresetsFromRedis() {
  const data = await redisGetJson(KEYS.LAB_PRESETS);
  if (!data) return null;
  return Array.isArray(data.presets) ? data.presets : (Array.isArray(data) ? data : null);
}

async function setPresetsInRedis(presets) {
  return redisSetJson(KEYS.LAB_PRESETS, { presets });
}

async function getActivePresetFromRedis() {
  return redisGetJson(KEYS.LAB_ACTIVE_PRESET);
}

async function setActivePresetInRedis(preset) {
  return redisSetJson(KEYS.LAB_ACTIVE_PRESET, preset);
}

async function getCashAdjustmentsFromRedis() {
  return redisGetJson(KEYS.CASH_ADJUSTMENTS);
}

async function setCashAdjustmentsInRedis(state) {
  return redisSetJson(KEYS.CASH_ADJUSTMENTS, state);
}

module.exports = {
  KEYS,
  getBotProfileFromRedis,
  setBotProfileInRedis,
  getPresetsFromRedis,
  setPresetsInRedis,
  getActivePresetFromRedis,
  setActivePresetInRedis,
  getCashAdjustmentsFromRedis,
  setCashAdjustmentsInRedis,
};
