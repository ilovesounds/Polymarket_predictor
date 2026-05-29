/**
 * Persist paper-mode cash deposits/withdrawals (dashboard + bot restart).
 * File: data/cash-adjustments.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ADJUSTMENTS_PATH = path.join(DATA_DIR, 'cash-adjustments.json');

const EMPTY_STATE = Object.freeze({
  version: 1,
  netCashDelta: 0,
  startingCashBaseline: null,
  entries: [],
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_STATE, entries: [] };
  const entries = Array.isArray(raw.entries) ? raw.entries.map((e) => ({
    id: e.id || crypto.randomUUID(),
    delta: round2(Number(e.delta) || 0),
    timestamp: Number(e.timestamp) || Date.now(),
    updateBaseline: Boolean(e.updateBaseline),
    note: typeof e.note === 'string' ? e.note : null,
    appliedAt: e.appliedAt || null,
  })) : [];
  const netCashDelta = round2(
    Number.isFinite(raw.netCashDelta)
      ? raw.netCashDelta
      : entries.reduce((sum, e) => sum + e.delta, 0)
  );
  const baseline = Number.isFinite(raw.startingCashBaseline)
    ? round2(raw.startingCashBaseline)
    : null;
  return {
    version: 1,
    netCashDelta,
    startingCashBaseline: baseline,
    entries,
  };
}

function loadCashAdjustmentState() {
  try {
    if (!fs.existsSync(ADJUSTMENTS_PATH)) return { ...EMPTY_STATE, entries: [] };
    const raw = JSON.parse(fs.readFileSync(ADJUSTMENTS_PATH, 'utf8'));
    return normalizeState(raw);
  } catch (_) {
    return { ...EMPTY_STATE, entries: [] };
  }
}

function saveCashAdjustmentState(state) {
  ensureDataDir();
  const normalized = normalizeState(state);
  const tmp = `${ADJUSTMENTS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, ADJUSTMENTS_PATH);
  return normalized;
}

/**
 * @param {number} envStartingCash - STARTING_CASH from env
 */
function resolvePortfolioCashFromAdjustments(envStartingCash) {
  const state = loadCashAdjustmentState();
  const baseline = state.startingCashBaseline ?? envStartingCash;
  const cash = round2(envStartingCash + state.netCashDelta);
  return {
    cash,
    startingCash: baseline,
    netCashDelta: state.netCashDelta,
    state,
  };
}

/**
 * @param {{ delta: number, updateBaseline?: boolean, note?: string, envStartingCash?: number }} opts
 */
function appendCashAdjustment({
  delta,
  updateBaseline = false,
  note = null,
  envStartingCash = 0,
}) {
  const d = round2(Number(delta));
  if (!Number.isFinite(d) || d === 0) {
    throw new Error('delta must be a non-zero number');
  }
  const state = loadCashAdjustmentState();
  const entry = {
    id: crypto.randomUUID(),
    delta: d,
    timestamp: Date.now(),
    updateBaseline: Boolean(updateBaseline),
    note: note || null,
    appliedAt: null,
  };
  state.entries.push(entry);
  state.netCashDelta = round2(state.netCashDelta + d);
  if (updateBaseline && d > 0) {
    const prev = state.startingCashBaseline;
    const base = Number.isFinite(prev) ? prev : round2(envStartingCash);
    state.startingCashBaseline = round2(base + d);
  }
  return saveCashAdjustmentState(state);
}

function markEntriesApplied(ids = []) {
  if (!ids.length) return loadCashAdjustmentState();
  const state = loadCashAdjustmentState();
  const idSet = new Set(ids);
  let changed = false;
  for (const entry of state.entries) {
    if (idSet.has(entry.id) && !entry.appliedAt) {
      entry.appliedAt = Date.now();
      changed = true;
    }
  }
  return changed ? saveCashAdjustmentState(state) : state;
}

function listPendingEntries() {
  return loadCashAdjustmentState().entries.filter((e) => !e.appliedAt);
}

module.exports = {
  ADJUSTMENTS_PATH,
  loadCashAdjustmentState,
  saveCashAdjustmentState,
  resolvePortfolioCashFromAdjustments,
  appendCashAdjustment,
  markEntriesApplied,
  listPendingEntries,
};
