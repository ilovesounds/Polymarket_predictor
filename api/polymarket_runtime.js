/**
 * Runtime-safe polymarket client used by bot/backtest.
 */

const { fetchGamma, fetchClob, fetchDataApi } = require('../lib/httpFetch');
const { isRedisRequested } = require('../lib/redis');
const { getMarket, setMarket, getCachedActiveMarkets, cacheMarkets } = require('../lib/redisMarketCache');
const { getOrderbook: getOrderbookCached, setOrderbook: setOrderbookCached } = require('../lib/redisOrderbookCache');
const { pushPrice } = require('../lib/redisPriceBuffer');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const CLOB_WS_HEARTBEAT_MS = 9_000;
const GAMMA_CACHE_MS = Number(process.env.BOT_GAMMA_CACHE_MS || process.env.GAMMA_CACHE_MS || 40_000);

/** @type {{ ts: number, markets: object[] } | null} */
let activeMarketsCache = null;
/** @type {Map<string, { ts: number, data: object }>} */
const marketDetailCache = new Map();
/** @type {Map<string, { ts: number, data: object }>} */
const windowListCache = new Map();

const LONG_DATED_BLOCKLIST = /world cup|fifa|election|president|gta\s|super bowl|nba finals|oscar/;

const WINDOW_1D_MINUTES = 1440;

function parseWindowToken(v) {
  const t = String(v || '').toLowerCase().trim();
  if (t === '5' || t === '5m') return 5;
  if (t === '15' || t === '15m') return 15;
  if (t === '1d' || t === '1day' || t === 'daily' || t === String(WINDOW_1D_MINUTES)) return WINDOW_1D_MINUTES;
  return null;
}

function getAllowedWindows() {
  const raw = String(process.env.MARKET_WINDOW || 'all').toLowerCase().trim();
  if (raw === 'all') return [5, 15, WINDOW_1D_MINUTES];
  if (raw === 'both' || raw === '5,15' || raw === '15,5') return [5, 15];
  if (raw.includes(',')) {
    const parsed = [...new Set(raw.split(',').map((p) => parseWindowToken(p)).filter(Boolean))];
    if (parsed.length) return parsed;
  }
  const single = parseWindowToken(raw);
  if (single) return [single];
  return [5, 15, WINDOW_1D_MINUTES];
}

function isBtcRelated(text) {
  const t = String(text || '').toLowerCase();
  return /\bbtc\b|bitcoin/.test(t);
}

function detectWindowMinutes(text) {
  const t = String(text || '').toLowerCase();
  if (/btc-updown-1d|btc-updown-1d-/.test(t)) return WINDOW_1D_MINUTES;
  if (/btc-updown-15m|btc-updown-15m-/.test(t)) return 15;
  if (/btc-updown-5m|btc-updown-5m-/.test(t)) return 5;
  if (/bitcoin-up-or-down-on-|btc-updown-daily/.test(t)) return WINDOW_1D_MINUTES;
  if (/\bup\s+or\s+down\s+on\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) {
    return WINDOW_1D_MINUTES;
  }
  if (/\b1\s*[- ]?day\b|\b1d\b/.test(t) && /\bup\s+or\s+down\b|updown/.test(t)) return WINDOW_1D_MINUTES;
  if (/\bdaily\b/.test(t) && /\b(btc|bitcoin)\b/.test(t) && /\bup\s+or\s+down\b|updown/.test(t)) {
    return WINDOW_1D_MINUTES;
  }
  if (/\b15\s*[- ]?min(?:ute)?s?\b|\b15m\b|15-minute|15\s*minute/.test(t)) return 15;
  if (/\b5\s*[- ]?min(?:ute)?s?\b|\b5m\b|5-minute|5\s*minute/.test(t)) return 5;
  return null;
}

function matchBtcShortWindowMarket(raw, allowedWindows = getAllowedWindows()) {
  const question = String(raw.question || '');
  const slug = String(raw.slug || '');
  const tags = Array.isArray(raw.tags) ? raw.tags.join(' ') : String(raw.tags || '');
  const blob = `${question} ${slug} ${tags}`;

  if (LONG_DATED_BLOCKLIST.test(blob)) return null;
  if (!isBtcRelated(blob)) return null;

  const windowMinutes = detectWindowMinutes(blob);
  if (!windowMinutes || !allowedWindows.includes(windowMinutes)) return null;

  return { windowMinutes };
}

function parseTokenIds(rawTokenIds) {
  if (Array.isArray(rawTokenIds)) return rawTokenIds;
  if (typeof rawTokenIds === 'string') {
    try {
      const parsed = JSON.parse(rawTokenIds);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function parseOutcomePrices(raw) {
  return parseJsonArray(raw).map((p) => Number(p)).filter((p) => Number.isFinite(p));
}

function windowKeyToMinutes(windowKey) {
  return parseWindowToken(windowKey);
}

function isCacheFresh(entry) {
  return entry && (Date.now() - entry.ts) < GAMMA_CACHE_MS;
}

function parseSlugWindowStartMs(slug) {
  const m = String(slug || '').match(/btc-updown-(?:5m|15m|1d|4h)-(\d{9,11})$/i);
  if (!m) return null;
  const ts = Number(m[1]);
  return Number.isFinite(ts) ? ts * 1000 : null;
}

/** Window open (Chainlink reference time) for btc-updown markets. */
function parseWindowStartMs(market) {
  if (market?.windowStartTime && Number.isFinite(market.windowStartTime)) {
    return market.windowStartTime;
  }
  if (market?.eventStartTime) {
    const t = new Date(market.eventStartTime).getTime();
    if (Number.isFinite(t)) return t;
  }
  const fromSlug = parseSlugWindowStartMs(market?.slug);
  if (fromSlug) return fromSlug;
  if (Number.isFinite(market?.endTime) && market?.windowMinutes) {
    return market.endTime - market.windowMinutes * 60_000;
  }
  return null;
}

function normalizeGammaMarket(m, windowMinutes, eventSlug = '', eventMeta = null) {
  const tokenIds = parseTokenIds(m.clobTokenIds);
  const endTime = new Date(m.endDate).getTime();
  const slug = m.slug || eventSlug;
  const eventStartTime = m.eventStartTime || eventMeta?.startTime || eventMeta?.startDate || null;
  const windowStartTime = parseWindowStartMs({ slug, eventStartTime, endTime, windowMinutes });
  const outcomePrices = parseOutcomePrices(m.outcomePrices);
  const outcomes = parseJsonArray(m.outcomes);
  return {
    conditionId: m.conditionId,
    tokenIdYes: tokenIds[0],
    tokenIdNo: tokenIds[1],
    endTime,
    question: m.question,
    slug,
    eventSlug: eventSlug || null,
    eventStartTime,
    windowStartTime,
    liquidity: Number(m.liquidity) || 0,
    volume24h: Number(m.volume24hr ?? m.volume24h ?? m.volume) || null,
    volume: Number(m.volume) || null,
    windowMinutes,
    outcomePrices,
    outcomes,
    clobTokenIds: tokenIds,
    active: m.active !== false,
    closed: Boolean(m.closed),
    description: m.description || null,
    image: m.image || null,
    enableOrderBook: m.enableOrderBook !== false,
    startDate: m.startDate || null,
    createdAt: m.createdAt || null,
    updatedAt: m.updatedAt || null,
    event: eventMeta ? {
      id: eventMeta.id,
      title: eventMeta.title,
      slug: eventMeta.slug,
      startTime: eventMeta.startTime || eventMeta.startDate,
      endDate: eventMeta.endDate,
      volume24hr: Number(eventMeta.volume24hr) || null,
      liquidity: Number(eventMeta.liquidity) || null,
      tags: eventMeta.tags,
      seriesSlug: eventMeta.seriesSlug,
    } : null,
  };
}

function dedupeMarkets(markets) {
  const byId = new Map();
  for (const m of markets) {
    if (!m.conditionId) continue;
    byId.set(m.conditionId, m);
  }
  return [...byId.values()];
}

function horizonMsForWindow(windowMinutes) {
  return (windowMinutes * 60_000) + 90_000;
}

function selectNearestRelevantMarkets(markets, allowedWindows) {
  const now = Date.now();
  const windows = Array.isArray(allowedWindows) && allowedWindows.length ? allowedWindows : getAllowedWindows();

  const live = markets
    .filter((m) => Number.isFinite(m.endTime) && m.endTime > now)
    .filter((m) => windows.includes(m.windowMinutes));

  if (windows.length > 1) {
    const perWindow = Math.max(2, Math.ceil(8 / windows.length));
    const picked = [];
    for (const w of windows) {
      const horizonMs = horizonMsForWindow(w);
      const bucket = live
        .filter((m) => m.windowMinutes === w && (m.endTime - now) <= horizonMs)
        .sort((a, b) => a.endTime - b.endTime)
        .slice(0, perWindow);
      picked.push(...bucket);
    }
    if (picked.length) {
      return picked.sort((a, b) => a.endTime - b.endTime).slice(0, 8);
    }
  }

  const maxWindowMinutes = Math.max(...windows);
  const horizonMs = horizonMsForWindow(maxWindowMinutes);
  const sorted = live.sort((a, b) => a.endTime - b.endTime);
  const relevant = sorted.filter((m) => (m.endTime - now) <= horizonMs);
  const picked = relevant.length ? relevant : sorted.slice(0, 8);

  return picked.slice(0, 8);
}

async function fetchMarketsFromSearch(allowedWindows) {
  const matched = [];
  const maxPages = Number(process.env.MARKET_SEARCH_PAGES || 12);
  const queries = ['bitcoin up or down'];
  if (allowedWindows.includes(WINDOW_1D_MINUTES)) {
    queries.push('bitcoin up or down on');
  }

  for (const query of queries) {
  for (let page = 1; page <= maxPages; page++) {
    const url = `${GAMMA}/public-search?q=${encodeURIComponent(query)}&events_status=active&limit=50&page=${page}`;
    const res = await fetchGamma(url);
    const data = await res.json();
    const events = data.events || [];
    if (!events.length) break;

    for (const event of events) {
      const eventSlug = event.slug || '';
      const eventMeta = {
        id: event.id,
        title: event.title,
        slug: eventSlug,
        startTime: event.startTime,
        startDate: event.startDate,
        endDate: event.endDate,
        volume24hr: event.volume24hr,
        liquidity: event.liquidity,
        tags: event.tags,
        seriesSlug: event.seriesSlug,
      };
      const markets = event.markets?.length ? event.markets : [];
      for (const m of markets) {
        if (m.closed || m.active === false) continue;
        const meta = matchBtcShortWindowMarket(
          { question: m.question || event.title, slug: m.slug || eventSlug, tags: event.tags },
          allowedWindows
        );
        if (!meta) continue;
        const normalized = normalizeGammaMarket(m, meta.windowMinutes, eventSlug, eventMeta);
        if (normalized.conditionId && normalized.tokenIdYes && Number.isFinite(normalized.endTime)) {
          matched.push(normalized);
        }
      }
    }

    if (!data.pagination?.hasMore) break;
  }
  }

  return matched;
}

async function fetchMarketsFromCryptoTag(allowedWindows) {
  const res = await fetchGamma(`${GAMMA}/markets?tag=crypto&closed=false&limit=100&active=true`);
  const data = await res.json();
  const markets = Array.isArray(data) ? data : (data.markets || []);

  return markets
    .map((m) => {
      const meta = matchBtcShortWindowMarket(m, allowedWindows);
      if (!meta) return null;
      return normalizeGammaMarket(m, meta.windowMinutes, m.slug || '');
    })
    .filter(Boolean);
}

async function fetchAllActiveBTCMarketsRaw(allowedWindowsOverride = null) {
  const allowedWindows = Array.isArray(allowedWindowsOverride) && allowedWindowsOverride.length
    ? allowedWindowsOverride
    : getAllowedWindows();
  const cacheKey = allowedWindows.slice().sort((a, b) => a - b).join(',');
  if (activeMarketsCache && activeMarketsCache.key === cacheKey && isCacheFresh(activeMarketsCache)) {
    return activeMarketsCache.markets;
  }
  let combined = [];
  if (isRedisRequested()) {
    try {
      const cached = await getCachedActiveMarkets();
      if (cached.length) {
        const filtered = cached.filter((m) => allowedWindows.includes(m.windowMinutes));
        if (filtered.length) {
          activeMarketsCache = { key: cacheKey, ts: Date.now(), markets: filtered };
          return filtered;
        }
      }
    } catch (_) {}
  }

  combined = dedupeMarkets([
    ...(await fetchMarketsFromSearch(allowedWindows)),
    ...(await fetchMarketsFromCryptoTag(allowedWindows)),
  ]);
  activeMarketsCache = { key: cacheKey, ts: Date.now(), markets: combined };
  if (isRedisRequested()) {
    cacheMarkets(combined).catch(() => {});
  }
  return combined;
}

async function getActiveBTCShortMarkets(allowedWindowsOverride = null) {
  const allowedWindows = Array.isArray(allowedWindowsOverride) && allowedWindowsOverride.length
    ? allowedWindowsOverride
    : getAllowedWindows();
  const combined = await fetchAllActiveBTCMarketsRaw(allowedWindows);
  return selectNearestRelevantMarkets(combined, allowedWindows);
}

function listLiveMarketsForWindow(markets, windowKey) {
  const windowMinutes = windowKeyToMinutes(windowKey);
  if (!windowMinutes) return [];
  const now = Date.now();
  return (markets || [])
    .filter((m) => m.windowMinutes === windowMinutes && Number.isFinite(m.endTime) && m.endTime > now)
    .sort((a, b) => a.endTime - b.endTime);
}

async function listLiveBTCMarketsForWindow(windowKey) {
  const windowMinutes = windowKeyToMinutes(windowKey);
  if (!windowMinutes) return [];
  const cached = windowListCache.get(windowKey);
  if (isCacheFresh(cached)) return cached.data;

  const combined = await fetchAllActiveBTCMarketsRaw([5, 15, WINDOW_1D_MINUTES]);
  const list = listLiveMarketsForWindow(combined, windowKey);
  windowListCache.set(windowKey, { ts: Date.now(), data: list });
  return list;
}

async function fetchGammaMarketBySlug(slug) {
  if (!slug) return null;
  const res = await fetchGamma(`${GAMMA}/markets/slug/${encodeURIComponent(slug)}`);
  if (!res.ok) return null;
  return res.json();
}

async function fetchGammaEventBySlug(slug) {
  if (!slug) return null;
  const res = await fetchGamma(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
  if (!res.ok) return null;
  return res.json();
}

async function getMarketDetails(conditionId) {
  const id = String(conditionId || '').trim();
  if (!id) return null;

  const cached = marketDetailCache.get(id);
  if (isCacheFresh(cached)) return cached.data;

  if (isRedisRequested()) {
    try {
      const fromRedis = await getMarket(id);
      if (fromRedis?.conditionId) {
        marketDetailCache.set(id, { ts: Date.now(), data: fromRedis });
        return fromRedis;
      }
    } catch (_) {}
  }

  const combined = await fetchAllActiveBTCMarketsRaw([5, 15, WINDOW_1D_MINUTES]);
  let base = combined.find((m) => m.conditionId === id) || null;

  if (!base?.slug) {
    for (const w of ['5m', '15m', '1d']) {
      const list = await listLiveBTCMarketsForWindow(w);
      base = list.find((m) => m.conditionId === id);
      if (base) break;
    }
  }

  let rawMarket = null;
  if (base?.slug) {
    rawMarket = await fetchGammaMarketBySlug(base.slug);
  }

  const slug = base?.slug || rawMarket?.slug;
  const eventSlug = base?.eventSlug || base?.slug;
  let eventMeta = base?.event || null;
  if (eventSlug && (!eventMeta || !eventMeta.title)) {
    const ev = await fetchGammaEventBySlug(eventSlug);
    if (ev) {
      eventMeta = {
        id: ev.id,
        title: ev.title,
        slug: ev.slug,
        startTime: ev.startTime || ev.startDate,
        endDate: ev.endDate,
        volume24hr: ev.volume24hr,
        liquidity: ev.liquidity,
        tags: ev.tags,
        seriesSlug: ev.seriesSlug,
        description: ev.description,
        eventMetadata: ev.eventMetadata,
      };
    }
  }

  const source = rawMarket || base;
  if (!source) return null;

  const blob = `${source.question || ''} ${source.slug || slug || ''}`;
  const windowMinutes = base?.windowMinutes || detectWindowMinutes(blob);
  if (!windowMinutes) return null;

  const detail = normalizeGammaMarket(source, windowMinutes, eventSlug || slug || '', eventMeta);
  detail.polymarketUrl = slug ? `https://polymarket.com/event/${slug}` : null;

  marketDetailCache.set(id, { ts: Date.now(), data: detail });
  if (isRedisRequested()) {
    setMarket(detail).catch(() => {});
  }
  return detail;
}

/** @deprecated name kept for callers; returns strict BTC 5m/15m/1d markets only */
async function getActiveBTC15MinMarkets() {
  return getActiveBTCShortMarkets();
}

function resolveOutcomeFromMarket(m) {
  if (m.outcome) return m.outcome;
  const outcomes = Array.isArray(m.outcomes)
    ? m.outcomes
    : (typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : []);
  const prices = Array.isArray(m.outcomePrices)
    ? m.outcomePrices.map(Number)
    : (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices).map(Number) : []);
  if (!outcomes.length || !prices.length) return null;
  const winIdx = prices.findIndex((p) => p >= 0.99);
  if (winIdx < 0) return null;
  const label = outcomes[winIdx];
  if (String(label).toLowerCase() === 'up') return 'Yes';
  if (String(label).toLowerCase() === 'down') return 'No';
  return label;
}

function normalizeResolvedMarket(m, eventSlug = '') {
  const tokenIds = parseTokenIds(m.clobTokenIds);
  const blob = `${m.question || ''} ${m.slug || eventSlug}`;
  const windowMinutes = detectWindowMinutes(blob);
  return {
    conditionId: m.conditionId,
    tokenIdYes: tokenIds[0] || null,
    question: m.question,
    outcome: resolveOutcomeFromMarket(m),
    endTime: new Date(m.endDate).getTime(),
    windowMinutes,
  };
}

async function fetchResolvedMarketsFromSearch(allowedWindows, limit) {
  const matched = [];
  const maxPages = Number(process.env.RESOLVED_SEARCH_PAGES || 20);

  for (let page = 1; page <= maxPages; page++) {
    const url = `${GAMMA}/public-search?q=${encodeURIComponent('bitcoin up or down')}&events_status=closed&limit=50&page=${page}`;
    const res = await fetchGamma(url);
    const data = await res.json();
    const events = data.events || [];
    if (!events.length) break;

    for (const event of events) {
      const eventSlug = event.slug || '';
      for (const m of event.markets || []) {
        if (!m.closed) continue;
        const meta = matchBtcShortWindowMarket(
          { question: m.question || event.title, slug: m.slug || eventSlug, tags: event.tags },
          allowedWindows
        );
        if (!meta) continue;
        const normalized = normalizeResolvedMarket(m, eventSlug);
        if (normalized.conditionId && normalized.endTime) matched.push(normalized);
      }
    }

    if (matched.length >= limit || !data.pagination?.hasMore) break;
  }

  return matched;
}

async function getRecentResolvedMarkets(limit = 20, allowedWindows = getAllowedWindows()) {
  const fromSearch = await fetchResolvedMarketsFromSearch(allowedWindows, limit * 3);

  const fetchLimit = Math.max(limit * 4, 80);
  const res = await fetchGamma(`${GAMMA}/markets?tag=crypto&closed=true&limit=${fetchLimit}`);
  const data = await res.json();
  const markets = Array.isArray(data) ? data : (data.markets || []);
  const fromTag = markets
    .filter((m) => matchBtcShortWindowMarket(m, allowedWindows))
    .map((m) => normalizeResolvedMarket(m, m.slug || ''));

  const byId = new Map();
  for (const m of [...fromSearch, ...fromTag]) {
    if (!m.conditionId) continue;
    byId.set(m.conditionId, m);
  }

  return [...byId.values()]
    .sort((a, b) => b.endTime - a.endTime)
    .slice(0, limit);
}

/**
 * Fetch resolution outcome for a single market (open positions past endTime).
 * @param {string} conditionId
 * @returns {Promise<{ conditionId: string, outcome: string|null, endTime: number, question?: string, tokenIdYes?: string, windowMinutes?: number }|null>}
 */
async function getMarketResolution(conditionId, opts = {}) {
  const id = String(conditionId || '').trim();
  if (!id) return null;
  const slug = opts.slug || opts.marketSlug || null;
  const question = opts.question || null;

  if (slug) {
    try {
      const raw = await fetchGammaMarketBySlug(slug);
      if (raw?.conditionId === id || raw?.conditionId) {
        const normalized = normalizeResolvedMarket(raw, slug);
        if (normalized.outcome) return normalized;
      }
    } catch (_) {}
  }

  try {
    const res = await fetchGamma(`${GAMMA}/markets?condition_ids=${encodeURIComponent(id)}`);
    if (res.ok) {
      const data = await res.json();
      const raw = Array.isArray(data) ? data[0] : data;
      if (raw?.conditionId) {
        const normalized = normalizeResolvedMarket(raw, raw.slug || slug || '');
        if (normalized.outcome) return normalized;
        if (raw.slug) {
          const bySlug = await fetchGammaMarketBySlug(raw.slug);
          if (bySlug) {
            const fromSlug = normalizeResolvedMarket(bySlug, raw.slug);
            if (fromSlug.outcome) return fromSlug;
          }
        }
      }
    }
  } catch (_) {}

  const searchQueries = [
    question,
    'bitcoin up or down',
  ].filter(Boolean);

  for (const q of searchQueries) {
    try {
      const res = await fetchGamma(
        `${GAMMA}/public-search?q=${encodeURIComponent(q)}&events_status=closed&limit=30`
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const event of data.events || []) {
        for (const m of event.markets || []) {
          if (m.conditionId !== id) continue;
          const normalized = normalizeResolvedMarket(m, event.slug || m.slug || '');
          if (normalized.outcome) return normalized;
        }
      }
    } catch (_) {}
  }

  return null;
}

function recordRestLatency(streamKey, startedAt, meta) {
  try {
    require('../monitoring/latency').recordStreamLatency(streamKey, {
      sourceTs: startedAt,
      receivedTs: Date.now(),
      meta,
    });
  } catch (_) {}
}

async function getMidpoint(tokenId) {
  const startedAt = Date.now();
  const res = await fetchClob(`${CLOB}/midpoint?token_id=${tokenId}`);
  const data = await res.json();
  recordRestLatency('poly_midpoint_rest', startedAt, { tokenId: String(tokenId).slice(0, 12) });
  return parseFloat(data.mid);
}

async function getOrderBook(tokenId) {
  const id = String(tokenId || '').trim();
  if (!id) return { bids: [], asks: [] };

  if (isRedisRequested()) {
    try {
      const cached = await getOrderbookCached(id);
      if (cached?.bids || cached?.asks) return cached;
    } catch (_) {}
  }

  const startedAt = Date.now();
  const res = await fetchClob(`${CLOB}/book?token_id=${id}`);
  const data = await res.json();
  recordRestLatency('poly_orderbook_rest', startedAt, { tokenId: id.slice(0, 12) });
  const book = {
    bids: (data.bids || []).map((b) => [parseFloat(b.price), parseFloat(b.size)]),
    asks: (data.asks || []).map((a) => [parseFloat(a.price), parseFloat(a.size)]),
  };
  if (isRedisRequested()) {
    setOrderbookCached(id, book).catch(() => {});
  }
  return book;
}

async function getPriceHistory1Min(tokenId, intervalHours = 1) {
  const res = await fetchClob(`${CLOB}/prices-history?market=${tokenId}&interval=${intervalHours}h&fidelity=1`);
  const data = await res.json();
  return (data.history || []).map((c) => ({ t: c.t * 1000, p: parseFloat(c.p) }));
}

async function getTradeHistory(conditionId, limit = 500) {
  const trades = [];
  let offset = 0;
  const pageSize = Math.min(limit, 500);

  while (true) {
    const url = `${DATA_API}/trades?market=${encodeURIComponent(conditionId)}&limit=${pageSize}&offset=${offset}`;
    const res = await fetchDataApi(url);
    if (!res.ok) break;
    const data = await res.json();
    const batch = Array.isArray(data) ? data : (data.data || []);
    if (!batch.length) break;

    for (const t of batch) {
      const ts = Number(t.timestamp);
      const asset = String(t.asset || '');
      const isYesToken = asset && conditionId !== asset;
      trades.push({
        t: ts < 1e12 ? ts * 1000 : ts,
        price: parseFloat(t.price),
        side: t.side,
        size: parseFloat(t.size),
        asset,
        outcome: t.outcome,
      });
    }

    if (batch.length < pageSize) break;
    offset += pageSize;
    if (trades.length >= limit * 10) break;
  }

  if (trades.length) {
    return trades.sort((a, b) => a.t - b.t);
  }

  // Legacy CLOB fallback (may require API key)
  offset = 0;
  while (true) {
    const res = await fetchClob(`${CLOB}/trades?market=${conditionId}&limit=${limit}&offset=${offset}`);
    if (!res.ok) break;
    const data = await res.json();
    if (!data.data?.length) break;
    trades.push(...data.data.map((t) => ({
      t: parseInt(t.timestamp, 10) * 1000,
      price: parseFloat(t.price),
      side: t.side,
      size: parseFloat(t.size),
    })));
    if (data.data.length < limit) break;
    offset += limit;
  }

  return trades.sort((a, b) => a.t - b.t);
}

async function getLiquidityDepth(tokenId) {
  const book = await getOrderBook(tokenId);
  const bidDepth = book.bids.reduce((s, [, sz]) => s + sz, 0);
  const askDepth = book.asks.reduce((s, [, sz]) => s + sz, 0);
  return Math.min(bidDepth, askDepth);
}

function midFromBest(bestBid, bestAsk) {
  const bid = parseFloat(bestBid);
  const ask = parseFloat(bestAsk);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) return (bid + ask) / 2;
  if (Number.isFinite(ask) && ask > 0) return ask;
  if (Number.isFinite(bid) && bid > 0) return bid;
  return null;
}

/** Fill missing YES/NO from the complementary side when only one is known. */
function pairYesNoPrices(yesPrice, noPrice) {
  let yes = Number.isFinite(yesPrice) ? yesPrice : null;
  let no = Number.isFinite(noPrice) ? noPrice : null;
  if (yes != null && no == null) no = Math.max(0, Math.min(1, 1 - yes));
  if (no != null && yes == null) yes = Math.max(0, Math.min(1, 1 - no));
  return { yes, no };
}

function parseClobTimestamp(raw) {
  if (raw == null || raw === '') return Date.now();
  const n = Number(raw);
  if (!Number.isFinite(n)) return Date.now();
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Normalize CLOB last_trade_price to dashboard trade shape.
 * @returns {{ side: 'YES'|'NO', size: number, price: number, ts_ms: number, usdc: number, taker: null, clobSide: string|null, assetId: string, tradeKey: string }|null}
 */
function normalizeTradeFromClob(item, tokenIdYes, tokenIdNo) {
  if (!item || item.event_type !== 'last_trade_price') return null;
  const assetId = String(item.asset_id || '');
  if (!assetId) return null;

  let side = null;
  if (tokenIdYes && assetId === tokenIdYes) side = 'YES';
  else if (tokenIdNo && assetId === tokenIdNo) side = 'NO';
  else return null;

  const price = parseFloat(item.price);
  const size = parseFloat(item.size);
  if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) return null;

  const ts_ms = parseClobTimestamp(item.timestamp);
  const clobSideRaw = String(item.side || '').toUpperCase();
  const clobSide = clobSideRaw === 'BUY' || clobSideRaw === 'SELL' ? clobSideRaw : null;

  return {
    side,
    size,
    price,
    ts_ms,
    usdc: size * price,
    taker: null,
    clobSide,
    assetId,
    tradeKey: `${assetId}:${ts_ms}:${price.toFixed(6)}:${size.toFixed(4)}:${clobSide || ''}`,
  };
}

function parseClobMarketMessage(raw, assetIdSet, onPrice, tradeCtx) {
  if (raw === 'PONG') return;
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    return;
  }

  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const type = item.event_type;

    if (type === 'best_bid_ask' && assetIdSet.has(item.asset_id)) {
      const mid = midFromBest(item.best_bid, item.best_ask);
      const meta = { sourceTs: parseClobTimestamp(item.timestamp), receivedAt: Date.now(), eventType: type };
      if (mid != null) onPrice(item.asset_id, mid, type, meta);
      continue;
    }
    if (type === 'last_trade_price' && assetIdSet.has(item.asset_id)) {
      if (tradeCtx?.onTrade) {
        const trade = normalizeTradeFromClob(item, tradeCtx.tokenIdYes, tradeCtx.tokenIdNo);
        if (trade) tradeCtx.onTrade(trade);
      }
      const p = parseFloat(item.price);
      if (Number.isFinite(p)) {
        const meta = { sourceTs: parseClobTimestamp(item.timestamp), receivedAt: Date.now(), eventType: type };
        onPrice(item.asset_id, p, type, meta);
      }
      continue;
    }
    if (type === 'price_change' && Array.isArray(item.price_changes)) {
      for (const ch of item.price_changes) {
        if (!ch?.asset_id || !assetIdSet.has(ch.asset_id)) continue;
        const mid = midFromBest(ch.best_bid, ch.best_ask);
        if (mid != null) {
          const meta = { sourceTs: parseClobTimestamp(item.timestamp || ch.timestamp), receivedAt: Date.now(), eventType: type };
          onPrice(ch.asset_id, mid, type, meta);
        }
      }
      continue;
    }
    if (type === 'book' && assetIdSet.has(item.asset_id)) {
      const bids = item.bids || [];
      const asks = item.asks || [];
      const bestBid = bids.length ? bids[bids.length - 1]?.price ?? bids[0]?.price : null;
      const bestAsk = asks.length ? asks[0]?.price : null;
      const mid = midFromBest(bestBid, bestAsk);
      if (mid != null) {
        const meta = { sourceTs: parseClobTimestamp(item.timestamp), receivedAt: Date.now(), eventType: type };
        onPrice(item.asset_id, mid, type, meta);
      }
    }
  }
}

/**
 * Subscribe to CLOB market channel for one or more token IDs (single connection).
 * onPrice(assetId, price, eventType)
 */
function subscribeClobAssets(assetIds, onPrice, onError, tradeCtx) {
  const ids = [...new Set((assetIds || []).filter(Boolean))];
  if (!ids.length) {
    return { ws: null, close() {} };
  }

  const WS = globalThis.WebSocket || require('ws');
  const assetIdSet = new Set(ids);
  const ws = new WS(CLOB_WS);
  let pingTimer = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    try { ws.close(); } catch (_) {}
  };

  ws.onopen = () => {
    ws.send(JSON.stringify({
      assets_ids: ids,
      type: 'market',
      custom_feature_enabled: true,
    }));
    pingTimer = setInterval(() => {
      if (ws.readyState === WS.OPEN) ws.send('PING');
    }, CLOB_WS_HEARTBEAT_MS);
  };

  ws.onmessage = (msg) => {
    try {
      const raw = typeof msg.data === 'string' ? msg.data : msg.data?.toString?.();
      parseClobMarketMessage(raw, assetIdSet, onPrice, tradeCtx);
    } catch (e) {
      if (onError) onError(e);
    }
  };

  ws.onerror = (err) => {
    if (onError) onError(err);
    else console.error('[CLOB WS] error:', err?.message || err);
  };

  ws.onclose = () => cleanup();

  return { ws, close: cleanup };
}

/** @deprecated Prefer subscribeClobAssets for YES+NO on one socket */
function subscribeLivePrice(tokenId, onPrice, onError) {
  const handle = subscribeClobAssets(
    [tokenId],
    (_assetId, price) => onPrice(price),
    onError
  );
  return handle.ws || handle;
}

async function placeOrder({ tokenId, price, size, side, signer }) {
  const orderData = { tokenId, price: price.toFixed(4), size: size.toFixed(2), side, type: 'LIMIT', timeInForce: 'GTC', feeRateBps: 200 };
  const domain = { name: 'Polymarket CTF Exchange', version: '1', chainId: 137, verifyingContract: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' };
  const types = { Order: [{ name: 'tokenId', type: 'uint256' }, { name: 'price', type: 'uint256' }, { name: 'size', type: 'uint256' }, { name: 'side', type: 'uint8' }, { name: 'timeInForce', type: 'uint8' }] };
  const signature = await signer.signTypedData(domain, types, orderData);
  const res = await fetchClob(`${CLOB}/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...orderData, signature }) });
  return res.json();
}

module.exports = {
  WINDOW_1D_MINUTES,
  GAMMA_CACHE_MS,
  getActiveBTCShortMarkets,
  fetchAllActiveBTCMarketsRaw,
  listLiveBTCMarketsForWindow,
  listLiveMarketsForWindow,
  getMarketDetails,
  getActiveBTC15MinMarkets,
  getRecentResolvedMarkets,
  getMarketResolution,
  resolveOutcomeFromMarket,
  matchBtcShortWindowMarket,
  detectWindowMinutes,
  parseWindowToken,
  windowKeyToMinutes,
  parseWindowStartMs,
  parseSlugWindowStartMs,
  getAllowedWindows,
  getMidpoint,
  getOrderBook,
  getPriceHistory1Min,
  getTradeHistory,
  getLiquidityDepth,
  pairYesNoPrices,
  normalizeTradeFromClob,
  parseClobTimestamp,
  subscribeClobAssets,
  subscribeLivePrice,
  placeOrder,
};
