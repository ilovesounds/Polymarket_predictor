/**
 * Named bot profiles (strategy + sizing + lab gates + session).
 * File: data/bot-profiles.json
 */
const fs = require('fs');
const path = require('path');
const { defaultPresetFields } = require('./strategyLab');
const { defaultBotProfile, normalizeBotProfile } = require('./botProfile');
const { resolveSizingConfig } = require('./betSizing');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'bot-profiles.json');

const LAB_FIELD_KEYS = [
  'maxSpreadCents',
  'minDepthUsd',
  'minVolume24h',
  'maxImbalanceAbs',
  'maxSlippagePct',
  'maxPositionPctOfLiquidity',
  'ticksFromMid',
  'gateMode',
];

const SIZING_FIELD_KEYS = [
  'sizingMode',
  'fixedBetUsd',
  'betPercent',
  'kellyFractionCap',
  'defaultWinRate',
  'cashFraction',
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function buildProfileSeed(id = 'default', name = 'Default compound') {
  const bot = defaultBotProfile();
  const lab = defaultPresetFields();
  return {
    id,
    name,
    ...bot,
    ...pickFields(lab, [...LAB_FIELD_KEYS, ...SIZING_FIELD_KEYS]),
  };
}

function defaultNamedProfile(id = 'default', name = 'Default compound') {
  return normalizeNamedProfile(buildProfileSeed(id, name), buildProfileSeed(id, name));
}

function pickFields(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj && obj[key] != null) out[key] = obj[key];
  }
  return out;
}

function slugId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `profile-${Date.now()}`;
}

/**
 * @param {object} input
 * @param {object} [base]
 */
function normalizeNamedProfile(input = {}, base = null) {
  const seed = base || buildProfileSeed(input.id, input.name);
  const merged = { ...seed, ...input };

  if (input.id != null) merged.id = slugId(input.id);
  if (input.name != null) merged.name = String(input.name).trim() || seed.name;

  const botNorm = normalizeBotProfile(merged, seed);
  Object.assign(merged, botNorm);

  if ('betPercent' in input || merged.sizingMode === 'percent' || merged.sizingMode === 'amount_cap') {
    const pct = Number(merged.betPercent);
    merged.betPercent = Number.isFinite(pct) ? Math.min(100, Math.max(1, pct)) : 25;
  }
  if ('fixedBetUsd' in input || merged.sizingMode === 'fixed' || merged.sizingMode === 'amount_cap') {
    const fixed = Number(merged.fixedBetUsd);
    merged.fixedBetUsd = Number.isFinite(fixed) && fixed > 0 ? fixed : seed.fixedBetUsd ?? 5;
  }
  if ('kellyFractionCap' in input) {
    const cap = Number(merged.kellyFractionCap);
    merged.kellyFractionCap = Number.isFinite(cap) && cap > 0 ? cap : 0.08;
  }
  if (merged.sizingMode != null) {
    const mode = String(merged.sizingMode).toLowerCase();
    merged.sizingMode = ['kelly', 'fixed', 'compound', 'percent', 'amount_cap'].includes(mode)
      ? mode
      : seed.sizingMode;
  }

  for (const key of LAB_FIELD_KEYS) {
    if (merged[key] == null && seed[key] != null) merged[key] = seed[key];
  }

  return merged;
}

function readProfilesFile() {
  try {
    if (!fs.existsSync(PROFILES_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    return Array.isArray(raw.profiles) ? raw.profiles : [];
  } catch (_) {
    return [];
  }
}

function writeProfilesFile(profiles) {
  ensureDataDir();
  fs.writeFileSync(PROFILES_FILE, `${JSON.stringify({ profiles }, null, 2)}\n`, 'utf8');
}

function listBotProfiles() {
  return readProfilesFile().map((p) => normalizeNamedProfile(p));
}

function getBotProfileById(id) {
  if (!id) return null;
  const found = readProfilesFile().find((p) => p.id === id);
  return found ? normalizeNamedProfile(found) : null;
}

function ensureDefaultProfiles(envStartingCash) {
  let profiles = readProfilesFile();
  if (!profiles.length) {
    profiles = [
      normalizeNamedProfile({
        id: 'default',
        name: 'Default compound',
        sizingMode: 'compound',
        strategyId: 'deterministic_yes_50',
        marketWindow: '5m',
      }),
      normalizeNamedProfile({
        id: 'conservative-25',
        name: 'Conservative 25%',
        sizingMode: 'percent',
        betPercent: 25,
        strategyId: 'conservative_yes_55',
        marketWindow: '5m',
        stopLossPct: 10,
        maxTradesPerMarket: 3,
      }),
    ];
    writeProfilesFile(profiles);
  }
  return profiles.map((p) => normalizeNamedProfile(p));
}

function saveNamedProfile(profile) {
  const profiles = readProfilesFile();
  const normalized = normalizeNamedProfile(profile);
  const now = Date.now();
  normalized.updatedAt = now;
  const idx = profiles.findIndex((p) => p.id === normalized.id);
  if (idx >= 0) {
    profiles[idx] = { ...profiles[idx], ...normalized, createdAt: profiles[idx].createdAt || now };
  } else {
    normalized.createdAt = now;
    profiles.push(normalized);
  }
  writeProfilesFile(profiles);
  return normalized;
}

function deleteNamedProfile(id) {
  const profiles = readProfilesFile().filter((p) => p.id !== id);
  writeProfilesFile(profiles);
  return profiles.map((p) => normalizeNamedProfile(p));
}

function duplicateNamedProfile(id, name) {
  const source = getBotProfileById(id);
  if (!source) return null;
  const copy = normalizeNamedProfile({
    ...source,
    id: slugId(name || `${source.name} copy`),
    name: name || `${source.name} (copy)`,
  });
  return saveNamedProfile(copy);
}

function profileBotFields(profile) {
  return normalizeBotProfile(profile);
}

function profileLabPresetFields(profile) {
  const p = normalizeNamedProfile(profile);
  return {
    id: p.id,
    name: p.name,
    ...pickFields(p, LAB_FIELD_KEYS),
    ...pickFields(p, SIZING_FIELD_KEYS),
  };
}

function profileSizingConfig(profile) {
  return resolveSizingConfig(profileLabPresetFields(profile));
}

function profileToSpawnEnv(profile, env = process.env) {
  const { profileToEnv } = require('./botProfile');
  const p = normalizeNamedProfile(profile);
  const lab = profileLabPresetFields(p);
  const sizing = resolveSizingConfig(lab);
  const spawn = {
    ...profileToEnv(p),
    BOT_PROFILE_ID: p.id,
    SIZING_MODE: sizing.sizingMode,
    FIXED_BET_USD: String(sizing.fixedBetUsd),
    BET_PERCENT_OF_BANKROLL: String(sizing.betPercent ?? 25),
    KELLY_FRACTION_CAP: String(sizing.kellyFractionCap),
    KELLY_DEFAULT_WIN_RATE: String(sizing.defaultWinRate ?? 0.55),
    POSITION_CASH_FRACTION: String(sizing.cashFraction ?? 1),
    PAPER_WALLET_PROFILE: p.id,
  };
  if (Number.isFinite(env.STARTING_CASH)) {
    spawn.STARTING_CASH = String(env.STARTING_CASH);
    spawn.STARTING_BANKROLL = String(env.STARTING_CASH);
  }
  return spawn;
}

function previewBetForProfile(profile, bankroll) {
  const { previewBetSize } = require('./betSizing');
  const sizing = profileSizingConfig(profile);
  const cash = Number.isFinite(bankroll) ? bankroll : 20;
  const result = previewBetSize(cash, sizing);
  const pct = cash > 0 ? (result.betSize / cash) * 100 : 0;
  return {
    bankroll: cash,
    betSize: result.betSize,
    pctOfBankroll: Math.round(pct * 100) / 100,
    sizingMode: sizing.sizingMode,
    betPercent: sizing.betPercent,
    label: `Next bet ≈ $${result.betSize.toFixed(2)} (${pct.toFixed(1)}% of $${cash.toFixed(2)})`,
  };
}

module.exports = {
  PROFILES_FILE,
  LAB_FIELD_KEYS,
  SIZING_FIELD_KEYS,
  slugId,
  defaultNamedProfile,
  normalizeNamedProfile,
  ensureDefaultProfiles,
  listBotProfiles,
  getBotProfileById,
  saveNamedProfile,
  deleteNamedProfile,
  duplicateNamedProfile,
  profileBotFields,
  profileLabPresetFields,
  profileSizingConfig,
  profileToSpawnEnv,
  previewBetForProfile,
};
