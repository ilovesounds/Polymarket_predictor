/**
 * Strategy Lab preset storage (file-backed) shared by dashboard and bot.
 */
const fs = require('fs');
const path = require('path');
const { loadDefaultThresholds } = require('../signals/marketParams');
const { defaultSizingFromEnv } = require('./betSizing');
const { isRedisRequested } = require('./redis');
const {
  getPresetsFromRedis,
  setPresetsInRedis,
  getActivePresetFromRedis,
  setActivePresetInRedis,
} = require('./redisProfileStore');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PRESETS_FILE = path.join(DATA_DIR, 'strategy-presets.json');
const ACTIVE_PRESET_FILE = path.join(DATA_DIR, 'strategy-active-preset.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function defaultPresetFields() {
  const t = loadDefaultThresholds();
  const s = defaultSizingFromEnv();
  return {
    maxSpreadCents: t.maxSpreadCents,
    minDepthUsd: t.minDepthUsd,
    minVolume24h: t.minVolume24h,
    maxImbalanceAbs: t.maxImbalanceAbs,
    maxSlippagePct: t.maxSlippagePct,
    maxPositionPctOfLiquidity: t.maxPositionPctOfLiquidity,
    ticksFromMid: t.ticksFromMid,
    gateMode: t.gateMode,
    sizingMode: s.sizingMode,
    fixedBetUsd: s.fixedBetUsd,
    kellyFractionCap: s.kellyFractionCap,
    defaultWinRate: s.defaultWinRate,
  };
}

function listPresetsFromFile() {
  const data = readJsonFile(PRESETS_FILE, { presets: [] });
  return Array.isArray(data.presets) ? data.presets : [];
}

function listPresets() {
  return listPresetsFromFile();
}

async function listPresetsAsync() {
  if (isRedisRequested()) {
    try {
      const fromRedis = await getPresetsFromRedis();
      if (fromRedis?.length) {
        writeJsonFile(PRESETS_FILE, { presets: fromRedis });
        return fromRedis;
      }
    } catch (_) {}
  }
  return listPresetsFromFile();
}

function savePreset(preset) {
  const presets = listPresets();
  const now = Date.now();
  const id = preset.id || `preset-${now}`;
  const entry = {
    id,
    name: preset.name || `Preset ${presets.length + 1}`,
    ...defaultPresetFields(),
    ...preset,
    updatedAt: now,
    createdAt: preset.createdAt || now,
  };

  const idx = presets.findIndex((p) => p.id === id);
  if (idx >= 0) presets[idx] = { ...presets[idx], ...entry };
  else presets.push(entry);

  writeJsonFile(PRESETS_FILE, { presets });
  if (isRedisRequested()) {
    setPresetsInRedis(presets).catch((err) => {
      console.warn('[StrategyLab] Redis presets mirror failed:', err?.message || err);
    });
  }
  return entry;
}

function getPresetById(id) {
  return listPresets().find((p) => p.id === id) || null;
}

function getActivePresetFromFile() {
  const active = readJsonFile(ACTIVE_PRESET_FILE, null);
  if (active && typeof active === 'object') {
    return { ...defaultPresetFields(), ...active };
  }
  return { ...defaultPresetFields(), id: 'env-default', name: 'Environment defaults' };
}

function getActivePreset() {
  return getActivePresetFromFile();
}

async function getActivePresetAsync() {
  if (isRedisRequested()) {
    try {
      const fromRedis = await getActivePresetFromRedis();
      if (fromRedis && typeof fromRedis === 'object') {
        const merged = { ...defaultPresetFields(), ...fromRedis };
        writeJsonFile(ACTIVE_PRESET_FILE, merged);
        return merged;
      }
    } catch (_) {}
  }
  return getActivePresetFromFile();
}

function setActivePreset(preset) {
  const merged = {
    ...defaultPresetFields(),
    ...preset,
    appliedAt: Date.now(),
  };
  writeJsonFile(ACTIVE_PRESET_FILE, merged);
  if (isRedisRequested()) {
    setActivePresetInRedis(merged).catch((err) => {
      console.warn('[StrategyLab] Redis active preset mirror failed:', err?.message || err);
    });
  }
  return merged;
}

function deletePreset(id) {
  const presets = listPresets().filter((p) => p.id !== id);
  writeJsonFile(PRESETS_FILE, { presets });
  if (isRedisRequested()) {
    setPresetsInRedis(presets).catch(() => {});
  }
  const active = getActivePreset();
  if (active.id === id) {
    try { fs.unlinkSync(ACTIVE_PRESET_FILE); } catch (_) {}
  }
  return presets;
}

module.exports = {
  PRESETS_FILE,
  ACTIVE_PRESET_FILE,
  defaultPresetFields,
  listPresets,
  listPresetsAsync,
  savePreset,
  getPresetById,
  getActivePreset,
  getActivePresetAsync,
  setActivePreset,
  deletePreset,
};
