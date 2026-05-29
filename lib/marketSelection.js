/**
 * Shared live-market selection for dashboard, bot env, and feed publishers.
 * Always prefers the nearest-expiring market that is still open (endTime > now).
 */

const WINDOW_1D_MINUTES = 1440;

function normalizePolyMode(mode) {
  const v = String(mode || '').trim().toLowerCase();
  if (v === '5' || v === '5m') return '5m';
  if (v === '15' || v === '15m') return '15m';
  if (v === '1d' || v === '1day' || v === 'daily' || v === '1440') return '1d';
  if (v === 'both' || v === '5,15' || v === '15,5') return 'both';
  if (v === 'all') return 'all';
  return '15m';
}

function modeToWindows(mode) {
  const normalized = normalizePolyMode(mode);
  if (normalized === '5m') return [5];
  if (normalized === '15m') return [15];
  if (normalized === '1d') return [WINDOW_1D_MINUTES];
  if (normalized === 'all') return [5, 15, WINDOW_1D_MINUTES];
  return [5, 15];
}

function polyModeToMarketWindow(mode) {
  const normalized = normalizePolyMode(mode);
  if (normalized === 'both') return 'both';
  if (normalized === 'all') return 'all';
  if (normalized === '1d') return '1d';
  return normalized.replace('m', '');
}

function windowMinutesToMode(windowMinutes) {
  if (windowMinutes === WINDOW_1D_MINUTES) return '1d';
  if (windowMinutes === 5) return '5m';
  if (windowMinutes === 15) return '15m';
  return null;
}

function isMarketLive(market, now = Date.now()) {
  return Boolean(
    market?.conditionId
    && Number.isFinite(market?.endTime)
    && market.endTime > now
  );
}

function filterLiveMarkets(markets, allowedWindowMinutes, now = Date.now()) {
  const allowed = Array.isArray(allowedWindowMinutes) && allowedWindowMinutes.length
    ? allowedWindowMinutes
    : [5, 15, WINDOW_1D_MINUTES];
  const byId = new Map();
  for (const m of markets || []) {
    if (!isMarketLive(m, now)) continue;
    if (!allowed.includes(m.windowMinutes)) continue;
    byId.set(m.conditionId, m);
  }
  return [...byId.values()].sort((a, b) => a.endTime - b.endTime);
}

function filterLiveMarketsForMode(markets, mode, now = Date.now()) {
  return filterLiveMarkets(markets, modeToWindows(mode), now);
}

/**
 * Pick the current live market in a series (nearest endTime).
 * Uses preferredId only when that market is still live.
 */
function pickPrimaryLiveMarket(markets, modeOrWindows, preferredId = null, now = Date.now()) {
  const allowed = Array.isArray(modeOrWindows)
    ? modeOrWindows
    : modeToWindows(modeOrWindows);
  const live = filterLiveMarkets(markets, allowed, now);
  if (preferredId) {
    const preferred = live.find((m) => m.conditionId === preferredId);
    if (preferred && allowed.includes(preferred.windowMinutes)) return preferred;
  }
  return live[0] || null;
}

function primaryNeedsRoll(primary, now = Date.now()) {
  return !primary || !isMarketLive(primary, now);
}

module.exports = {
  WINDOW_1D_MINUTES,
  normalizePolyMode,
  modeToWindows,
  polyModeToMarketWindow,
  windowMinutesToMode,
  isMarketLive,
  filterLiveMarkets,
  filterLiveMarketsForMode,
  pickPrimaryLiveMarket,
  primaryNeedsRoll,
};
