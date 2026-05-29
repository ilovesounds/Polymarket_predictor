/**
 * Shared live-market selection for dashboard, bot env, and feed publishers.
 * Prefers the window currently in progress (windowStartTime <= now < endTime),
 * then the nearest upcoming slot.
 */

const WINDOW_1D_MINUTES = 1440;
/** Never auto-select an upcoming slot this far ahead when an active window exists. */
const UPCOMING_PRIMARY_MAX_LEAD_MS = 2 * 60_000;

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

function parseSlugWindowStartMs(slug) {
  const m = String(slug || '').match(/btc-updown-(?:5m|15m|1d|4h)-(\d{9,11})$/i);
  if (!m) return null;
  const ts = Number(m[1]);
  return Number.isFinite(ts) ? ts * 1000 : null;
}

/** Window open (Chainlink reference time) for btc-updown markets. */
function parseWindowStartMs(market) {
  const fromSlug = parseSlugWindowStartMs(market?.slug);
  if (fromSlug) return fromSlug;
  if (market?.windowStartTime && Number.isFinite(market.windowStartTime)) {
    return market.windowStartTime;
  }
  if (market?.eventStartTime) {
    const t = new Date(market.eventStartTime).getTime();
    if (Number.isFinite(t)) return t;
  }
  if (Number.isFinite(market?.endTime) && market?.windowMinutes) {
    return market.endTime - market.windowMinutes * 60_000;
  }
  return null;
}

function isMarketOpen(market, now = Date.now()) {
  return Boolean(
    market?.conditionId
    && Number.isFinite(market?.endTime)
    && market.endTime > now,
  );
}

/** Window has started and not yet resolved. */
function isWindowActive(market, now = Date.now()) {
  if (!isMarketOpen(market, now)) return false;
  const start = parseWindowStartMs(market);
  if (!Number.isFinite(start)) return true;
  return start <= now;
}

function msUntilWindowStart(market, now = Date.now()) {
  const start = parseWindowStartMs(market);
  return Number.isFinite(start) ? start - now : Infinity;
}

function maxUpcomingLeadMs(windowMinutes) {
  if (windowMinutes === WINDOW_1D_MINUTES) return 24 * 60 * 60_000;
  return (windowMinutes || 5) * 60_000;
}

function getWindowPhase(market, now = Date.now()) {
  if (!isMarketOpen(market, now)) return 'ended';
  if (isWindowActive(market, now)) return 'active';
  return 'upcoming';
}

/** @deprecated Use isWindowActive for "current slot"; kept for callers that mean "not resolved". */
function isMarketLive(market, now = Date.now()) {
  return isWindowActive(market, now);
}

function partitionOpenMarkets(markets, allowedWindowMinutes, now = Date.now()) {
  const allowed = Array.isArray(allowedWindowMinutes) && allowedWindowMinutes.length
    ? allowedWindowMinutes
    : [5, 15, WINDOW_1D_MINUTES];
  const active = [];
  const upcoming = [];
  for (const m of markets || []) {
    if (!isMarketOpen(m, now) || !allowed.includes(m.windowMinutes)) continue;
    if (isWindowActive(m, now)) active.push(m);
    else upcoming.push(m);
  }
  active.sort((a, b) => a.endTime - b.endTime);
  upcoming.sort((a, b) => msUntilWindowStart(a, now) - msUntilWindowStart(b, now));
  return { active, upcoming, allowed };
}

function filterUpcomingWithinLead(upcoming, allowed, now = Date.now(), maxLeadMs = null) {
  const maxLead = Number.isFinite(maxLeadMs)
    ? maxLeadMs
    : Math.max(...allowed.map((w) => maxUpcomingLeadMs(w)));
  return upcoming.filter((m) => msUntilWindowStart(m, now) <= maxLead);
}

function pickDefaultPrimary(active, upcoming, allowed, now = Date.now()) {
  if (active.length) return active[0];
  const near = filterUpcomingWithinLead(upcoming, allowed, now, UPCOMING_PRIMARY_MAX_LEAD_MS);
  if (near.length) return near[0];
  return null;
}

function isFarUpcomingPrimary(market, now = Date.now()) {
  if (!market || isWindowActive(market, now)) return false;
  const startIn = msUntilWindowStart(market, now);
  return Number.isFinite(startIn) && startIn > UPCOMING_PRIMARY_MAX_LEAD_MS;
}

function shouldIgnorePreferredId(preferredId, markets, allowed, now = Date.now()) {
  if (!preferredId || !markets?.length) return true;
  const preferred = markets.find((m) => m.conditionId === preferredId);
  if (!preferred) return true;
  const { active } = partitionOpenMarkets(markets, allowed, now);
  if (!active.length) return false;
  return isFarUpcomingPrimary(preferred, now) || !isWindowActive(preferred, now);
}

function filterLiveMarkets(markets, allowedWindowMinutes, now = Date.now()) {
  const { active, upcoming, allowed } = partitionOpenMarkets(markets, allowedWindowMinutes, now);
  const nearUpcoming = filterUpcomingWithinLead(upcoming, allowed, now);
  const list = active.length
    ? [...active, ...nearUpcoming.slice(0, 2)]
    : (nearUpcoming.length ? nearUpcoming : upcoming);
  const byId = new Map();
  for (const m of list) {
    if (m?.conditionId) byId.set(m.conditionId, m);
  }
  return [...byId.values()].sort((a, b) => {
    const aActive = isWindowActive(a, now);
    const bActive = isWindowActive(b, now);
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (aActive && bActive) return a.endTime - b.endTime;
    return msUntilWindowStart(a, now) - msUntilWindowStart(b, now);
  });
}

function filterLiveMarketsForMode(markets, mode, now = Date.now()) {
  return filterLiveMarkets(markets, modeToWindows(mode), now);
}

/**
 * Pick the current live market: active window first (soonest end), else nearest upcoming.
 * Ignores stale preferredId when it points at a far-future slot while an active window exists.
 */
function pickPrimaryLiveMarket(markets, modeOrWindows, preferredId = null, now = Date.now()) {
  const allowed = Array.isArray(modeOrWindows)
    ? modeOrWindows
    : modeToWindows(modeOrWindows);
  const { active, upcoming } = partitionOpenMarkets(markets, allowed, now);
  const defaultPick = pickDefaultPrimary(active, upcoming, allowed, now);

  let result;
  if (!preferredId || shouldIgnorePreferredId(preferredId, markets, allowed, now)) {
    result = defaultPick;
  } else {
    const preferred = markets.find((m) => m.conditionId === preferredId);
    if (!preferred || !isMarketOpen(preferred, now)) {
      result = defaultPick;
    } else if (isWindowActive(preferred, now)) {
      result = preferred;
    } else if (active.length) {
      result = active[0];
    } else {
      const startIn = msUntilWindowStart(preferred, now);
      if (Number.isFinite(startIn) && startIn <= UPCOMING_PRIMARY_MAX_LEAD_MS) {
        result = preferred;
      } else {
        result = defaultPick;
      }
    }
  }

  if (active.length && result && !isWindowActive(result, now)) {
    console.warn('[marketSelection] active window exists but primary is upcoming', {
      active: active[0]?.question?.slice(0, 56),
      activeSlug: active[0]?.slug,
      picked: result?.question?.slice(0, 56),
      pickedSlug: result?.slug,
      preferredId: preferredId?.slice(0, 14),
      startInMin: Number((msUntilWindowStart(result, now) / 60_000).toFixed(1)),
    });
  }

  return result;
}

function describePrimarySelection(markets, modeOrWindows, preferredId = null, now = Date.now()) {
  const allowed = Array.isArray(modeOrWindows)
    ? modeOrWindows
    : modeToWindows(modeOrWindows);
  const { active, upcoming } = partitionOpenMarkets(markets, allowed, now);
  const primary = pickPrimaryLiveMarket(markets, allowed, preferredId, now);
  const phase = primary ? getWindowPhase(primary, now) : null;
  const hasActiveWindow = active.length > 0;
  const nextStartInMs = !hasActiveWindow && upcoming.length
    ? msUntilWindowStart(upcoming[0], now)
    : null;
  return {
    primary,
    phase,
    hasActiveWindow,
    showingUpcomingOnly: Boolean(primary && phase === 'upcoming' && !hasActiveWindow),
    showingFarUpcoming: Boolean(primary && isFarUpcomingPrimary(primary, now)),
    nextStartInMs,
  };
}

/**
 * Roll when the primary market resolved, or when it is still upcoming but an
 * active window is available in the same series.
 */
function primaryNeedsRoll(primary, markets = null, modeOrWindows = null, now = Date.now()) {
  if (!primary || !isMarketOpen(primary, now)) return true;
  if (isWindowActive(primary, now)) return false;
  if (!markets?.length || modeOrWindows == null) return false;
  const allowed = Array.isArray(modeOrWindows)
    ? modeOrWindows
    : modeToWindows(modeOrWindows);
  const { active } = partitionOpenMarkets(markets, allowed, now);
  if (active.length) return true;
  return false;
}

module.exports = {
  WINDOW_1D_MINUTES,
  UPCOMING_PRIMARY_MAX_LEAD_MS,
  normalizePolyMode,
  modeToWindows,
  polyModeToMarketWindow,
  windowMinutesToMode,
  parseWindowStartMs,
  parseSlugWindowStartMs,
  isMarketOpen,
  isWindowActive,
  isMarketLive,
  getWindowPhase,
  msUntilWindowStart,
  filterLiveMarkets,
  filterLiveMarketsForMode,
  pickPrimaryLiveMarket,
  pickDefaultPrimary,
  describePrimarySelection,
  isFarUpcomingPrimary,
  shouldIgnorePreferredId,
  primaryNeedsRoll,
  partitionOpenMarkets,
};
