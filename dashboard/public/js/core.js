/**
 * Shared dashboard hub: single WebSocket, subscriber routing, API helpers.
 */
(() => {
  const handlers = new Set();
  const portfolioHandlers = new Set();
  let ws = null;
  let eventSource = null;
  let reconnectTimer = null;
  let sseReconnectTimer = null;
  const marketPrices = new Map();

  const PRIMARY_STORAGE_KEY = 'dashboardPrimaryMarketId';
  const FOLLOW_LIVE_KEY = 'dashboardFollowLiveWindow';
  const PRIMARY_PIN_KEYS = [
    'dashboardPrimaryMarketId',
    'selectedPrimaryMarketId',
    'primaryMarketId',
  ];
  const UPCOMING_PRIMARY_MAX_LEAD_MS = 2 * 60_000;
  const isLivePage = () => document.body?.dataset?.page === 'live';

  const state = {
    selectedPolyMode: '15m',
    selectedMarketId: null,
    selectedStrategy: 'deterministic_yes_50',
    strategies: [],
    feedSource: 'direct',
    lastPolyVia: null,
    binanceConnected: false,
    polymarketConnected: false,
    natsConnected: false,
    bot: { running: false, mode: 'paper', cash: Number.NaN, runProgress: null },
    portfolio: {
      mode: 'paper',
      cash: Number.NaN,
      startingCash: Number.NaN,
      netCashDelta: 0,
      envStartingCash: Number.NaN,
      portfolio: Number.NaN,
      realizedPnlTotal: 0,
      openPositions: [],
      openPositionValue: 0,
      totalUnrealizedPnl: 0,
      totalEquity: Number.NaN,
      roiPct: null,
      tradeHistory: [],
    },
    activePolyMarkets: [],
    primaryPoly: null,
    primaryPhase: null,
    hasActiveWindow: true,
    showingUpcomingOnly: false,
    nextStartInMs: null,
    polyLatest: { yes: null, no: null },
    lastOrderbook: null,
    btcSpot: null,
    chainlinkSpot: null,
    priceToBeat: null,
    priceToBeatSource: null,
    windowStartTime: null,
    followLiveWindow: true,
    btcHistory: [],
  };

  function fmtTs(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3 });
  }

  function fmtPrice(v, digits = 2) {
    if (!Number.isFinite(v)) return '—';
    return v >= 1 ? v.toFixed(digits) : v.toFixed(4);
  }

  function fmtDollars(v) {
    if (!Number.isFinite(v)) return '$—';
    return `$${v.toFixed(2)}`;
  }

  function fmtBtcUsd(v) {
    if (!Number.isFinite(v)) return '—';
    return v.toLocaleString(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function fmtSize(v) {
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(2);
  }

  function isFollowLiveWindow() {
    if (isLivePage()) return state.followLiveWindow !== false;
    try {
      const stored = localStorage.getItem(FOLLOW_LIVE_KEY);
      if (stored === '0') return false;
      if (stored === '1') return true;
    } catch (_) {}
    return true;
  }

  function setFollowLiveWindow(enabled) {
    state.followLiveWindow = enabled !== false;
    try {
      if (state.followLiveWindow) localStorage.setItem(FOLLOW_LIVE_KEY, '1');
      else localStorage.setItem(FOLLOW_LIVE_KEY, '0');
    } catch (_) {}
  }

  function clearPinnedPrimaryKeys() {
    for (const key of PRIMARY_PIN_KEYS) {
      try { localStorage.removeItem(key); } catch (_) {}
    }
    state.selectedMarketId = null;
  }

  function initLivePagePreferences() {
    if (!isLivePage()) return;
    setFollowLiveWindow(true);
    clearPinnedPrimaryKeys();
  }

  function fmtCountdown(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function modeToWindow(mode) {
    if (mode === '5m') return 5;
    if (mode === '15m') return 15;
    if (mode === '1d') return 1440;
    return null;
  }

  function formatWindowMinutes(windowMinutes) {
    if (windowMinutes === 1440) return '1d';
    return `${windowMinutes}m`;
  }

  function resolvedPolyPrices() {
    let yes = state.polyLatest.yes;
    let no = state.polyLatest.no;
    if (Number.isFinite(yes) && !Number.isFinite(no)) no = Math.max(0, Math.min(1, 1 - yes));
    if (Number.isFinite(no) && !Number.isFinite(yes)) yes = Math.max(0, Math.min(1, 1 - no));
    return { yes, no };
  }

  function positionMarketId(pos) {
    return pos?.marketId || pos?.conditionId || null;
  }

  function recordMarketPrices(conditionId, yesPrice, noPrice) {
    if (!conditionId) return;
    const cur = marketPrices.get(conditionId) || {};
    if (Number.isFinite(yesPrice)) cur.yes = yesPrice;
    if (Number.isFinite(noPrice)) cur.no = noPrice;
    cur.updatedAt = Date.now();
    marketPrices.set(conditionId, cur);
  }

  function markPriceForPosition(pos) {
    const id = positionMarketId(pos);
    const side = String(pos?.side || 'YES').toUpperCase();
    const book = id ? marketPrices.get(id) : null;
    if (book) {
      const fromBook = side === 'NO' ? book.no : book.yes;
      if (Number.isFinite(fromBook)) return fromBook;
    }
    if (Number.isFinite(pos?.currentPrice)) return pos.currentPrice;
    if (Number.isFinite(pos?.entryPrice)) return pos.entryPrice;
    return null;
  }

  function resolveShares(pos) {
    if (Number.isFinite(pos?.shares) && pos.shares > 0) return pos.shares;
    const entry = pos?.entryPrice;
    if (Number.isFinite(pos?.costBasis) && Number.isFinite(entry) && entry > 0) {
      return pos.costBasis / entry;
    }
    if (Number.isFinite(pos?.betSize) && Number.isFinite(entry) && entry > 0) {
      return pos.betSize / entry;
    }
    return null;
  }

  function resolveCostBasis(pos, shares) {
    if (Number.isFinite(pos?.costBasis)) return pos.costBasis;
    if (Number.isFinite(pos?.betSize)) return pos.betSize;
    if (Number.isFinite(shares) && Number.isFinite(pos?.entryPrice)) return shares * pos.entryPrice;
    return null;
  }

  function enrichOpenPosition(pos) {
    const shares = resolveShares(pos);
    const entryPrice = pos?.entryPrice;
    const currentPrice = markPriceForPosition(pos);
    const costBasis = resolveCostBasis(pos, shares);
    const currentValue = Number.isFinite(shares) && Number.isFinite(currentPrice)
      ? shares * currentPrice
      : pos?.currentValue;
    let unrealizedPnl = null;
    if (Number.isFinite(currentValue) && Number.isFinite(costBasis)) {
      unrealizedPnl = currentValue - costBasis;
    } else if (Number.isFinite(pos?.unrealizedPnl)) {
      unrealizedPnl = pos.unrealizedPnl;
    }
    const unrealizedPnlPct = Number.isFinite(unrealizedPnl) && Number.isFinite(costBasis) && costBasis > 0
      ? (unrealizedPnl / costBasis) * 100
      : null;
    return {
      ...pos,
      shares,
      costBasis,
      currentPrice,
      currentValue,
      unrealizedPnl,
      unrealizedPnlPct,
    };
  }

  function enrichPortfolioInPlace() {
    const p = state.portfolio;
    const openPositions = (p.openPositions || []).map(enrichOpenPosition);
    p.openPositions = openPositions;
    let openPositionValue = 0;
    let totalUnrealizedPnl = 0;
    for (const pos of openPositions) {
      if (Number.isFinite(pos.currentValue)) openPositionValue += pos.currentValue;
      if (Number.isFinite(pos.unrealizedPnl)) totalUnrealizedPnl += pos.unrealizedPnl;
    }
    p.openPositionValue = openPositionValue;
    p.totalUnrealizedPnl = totalUnrealizedPnl;
    p.openPositionCount = openPositions.length;
    const cash = Number.isFinite(p.cash) ? p.cash : (Number.isFinite(p.bankroll) ? p.bankroll : 0);
    const starting = Number.isFinite(p.startingCash) ? p.startingCash : p.startingBankroll;
    p.cash = cash;
    p.portfolio = cash + openPositionValue;
    p.totalEquity = p.portfolio;
    if (Number.isFinite(starting) && starting > 0) {
      p.roiPct = ((p.portfolio - starting) / starting) * 100;
    }
    return p;
  }

  function emitPortfolioUpdate(reason = 'refresh') {
    const portfolio = enrichPortfolioInPlace();
    const payload = {
      source: 'portfolio',
      type: 'updated',
      reason,
      portfolio,
      timestamp: Date.now(),
    };
    for (const fn of portfolioHandlers) {
      try { fn(portfolio, payload); } catch (_) {}
    }
    emit(payload);
    return portfolio;
  }

  function emit(msg) {
    for (const fn of handlers) {
      try { fn(msg); } catch (_) {}
    }
  }

  function applySystemMessage(msg) {
    if (msg.type === 'hello') {
      if (msg.selectedPolyMode) state.selectedPolyMode = msg.selectedPolyMode;
      if (msg.selectedMarketId) state.selectedMarketId = msg.selectedMarketId;
      if (msg.selectedStrategy) state.selectedStrategy = msg.selectedStrategy;
      if (Array.isArray(msg.strategies)) state.strategies = msg.strategies;
      if (msg.bot) {
        if (typeof msg.bot.running === 'boolean') state.bot.running = msg.bot.running;
        if (Number.isFinite(msg.bot.cash)) state.bot.cash = msg.bot.cash;
        else if (Number.isFinite(msg.bot.bankroll)) state.bot.cash = msg.bot.bankroll;
        if (msg.bot.strategyId) state.selectedStrategy = msg.bot.strategyId;
      }
      if (msg.portfolio) {
        applyPortfolioSnapshot(msg.portfolio);
        emitPortfolioUpdate('hello');
      }
      return;
    }
    if (msg.type !== 'status') return;
    if (msg.selectedPolyMode) state.selectedPolyMode = msg.selectedPolyMode;
    if (msg.selectedMarketId) state.selectedMarketId = msg.selectedMarketId;
    if (msg.selectedStrategy) state.selectedStrategy = msg.selectedStrategy;
    if (Array.isArray(msg.strategies)) state.strategies = msg.strategies;
    if (msg.feedSource) state.feedSource = msg.feedSource;
    if (msg.lastPolyVia) state.lastPolyVia = msg.lastPolyVia;
    if (typeof msg.binanceConnected === 'boolean') state.binanceConnected = msg.binanceConnected;
    if (typeof msg.polymarketConnected === 'boolean') state.polymarketConnected = msg.polymarketConnected;
    if (typeof msg.natsConnected === 'boolean') state.natsConnected = msg.natsConnected;
    if (msg.bot) {
      if (typeof msg.bot.running === 'boolean') state.bot.running = msg.bot.running;
      if (typeof msg.bot.mode === 'string') state.bot.mode = msg.bot.mode;
      if (msg.bot.runProgress) state.bot.runProgress = msg.bot.runProgress;
      if (Number.isFinite(msg.bot.cash)) state.bot.cash = msg.bot.cash;
      else if (Number.isFinite(msg.bot.bankroll)) state.bot.cash = msg.bot.bankroll;
      if (msg.bot.strategyId) state.selectedStrategy = msg.bot.strategyId;
    }
  }

  function applyBeatFromMarket(market) {
    if (!market) return;
    if (Number.isFinite(market.priceToBeat)) state.priceToBeat = market.priceToBeat;
    if (market.priceToBeatSource) state.priceToBeatSource = market.priceToBeatSource;
    if (Number.isFinite(market.windowStartTime)) state.windowStartTime = market.windowStartTime;
  }

  function parseSlugStartMs(slug) {
    const m = String(slug || '').match(/btc-updown-(?:5m|15m|1d|4h)-(\d{9,11})$/i);
    if (!m) return null;
    const ts = Number(m[1]);
    return Number.isFinite(ts) ? ts * 1000 : null;
  }

  function windowStartMs(market) {
    const fromSlug = parseSlugStartMs(market?.slug);
    if (fromSlug) return fromSlug;
    if (Number.isFinite(market?.windowStartTime)) return market.windowStartTime;
    if (Number.isFinite(market?.endTime) && market?.windowMinutes) {
      return market.endTime - market.windowMinutes * 60_000;
    }
    return null;
  }

  function isWindowActive(market, now = Date.now()) {
    if (!market?.conditionId || !Number.isFinite(market.endTime) || market.endTime <= now) return false;
    const start = windowStartMs(market);
    if (!Number.isFinite(start)) return true;
    return start <= now;
  }

  function isFarUpcoming(market, now = Date.now()) {
    if (!market || isWindowActive(market, now)) return false;
    const start = windowStartMs(market);
    return Number.isFinite(start) && (start - now) > UPCOMING_PRIMARY_MAX_LEAD_MS;
  }

  function shouldIgnoreStoredPrimary(markets, storedId, now = Date.now()) {
    if (!storedId || !markets?.length) return true;
    const preferred = markets.find((m) => m.conditionId === storedId);
    if (!preferred) return true;
    const active = markets.filter((m) => isWindowActive(m, now));
    if (!active.length) return false;
    return isFarUpcoming(preferred, now) || !isWindowActive(preferred, now);
  }

  function pickPrimaryFromMarkets(markets, serverSelectedId = null) {
    const selectedWindow = modeToWindow(state.selectedPolyMode);
    const now = Date.now();
    const open = (markets || [])
      .filter((m) => m?.conditionId && Number.isFinite(m.endTime) && m.endTime > now)
      .filter((m) => !selectedWindow || m.windowMinutes === selectedWindow);
    const active = open.filter((m) => isWindowActive(m, now)).sort((a, b) => a.endTime - b.endTime);
    const upcoming = open
      .filter((m) => !isWindowActive(m, now))
      .sort((a, b) => (windowStartMs(a) || Infinity) - (windowStartMs(b) || Infinity));
    const nearUpcoming = upcoming.filter((m) => {
      const start = windowStartMs(m);
      return !Number.isFinite(start) || (start - now) <= UPCOMING_PRIMARY_MAX_LEAD_MS;
    });
    const defaultPick = active[0] || nearUpcoming[0] || null;

    if (isFollowLiveWindow()) {
      if (serverSelectedId) {
        const fromServer = open.find((m) => m.conditionId === serverSelectedId);
        if (fromServer) return fromServer;
      }
      return defaultPick;
    }

    const storedId = state.selectedMarketId || localStorage.getItem(PRIMARY_STORAGE_KEY);
    if (!storedId || shouldIgnoreStoredPrimary(open, storedId, now)) return defaultPick;
    const preferred = open.find((m) => m.conditionId === storedId);
    if (!preferred) return defaultPick;
    if (isWindowActive(preferred, now)) return preferred;
    if (active.length) return active[0];
    const start = windowStartMs(preferred);
    if (Number.isFinite(start) && (start - now) <= UPCOMING_PRIMARY_MAX_LEAD_MS) return preferred;
    return defaultPick;
  }

  function updatePrimarySelectionMeta(markets, primary, msg = {}) {
    const now = Date.now();
    const selectedWindow = modeToWindow(state.selectedPolyMode);
    const open = (markets || state.activePolyMarkets || [])
      .filter((m) => m?.conditionId && Number.isFinite(m.endTime) && m.endTime > now)
      .filter((m) => !selectedWindow || m.windowMinutes === selectedWindow);
    const hasActiveWindow = open.some((m) => isWindowActive(m, now));
    const phase = primary
      ? (isWindowActive(primary, now) ? 'active' : 'upcoming')
      : null;
    state.hasActiveWindow = typeof msg.hasActiveWindow === 'boolean' ? msg.hasActiveWindow : hasActiveWindow;
    state.primaryPhase = msg.primaryPhase || phase;
    state.showingUpcomingOnly = typeof msg.showingUpcomingOnly === 'boolean'
      ? msg.showingUpcomingOnly
      : Boolean(primary && phase === 'upcoming' && !state.hasActiveWindow);
    if (Number.isFinite(msg.nextStartInMs)) state.nextStartInMs = msg.nextStartInMs;
    else if (!state.hasActiveWindow && open.length) {
      const next = open.find((m) => !isWindowActive(m, now));
      const start = next ? windowStartMs(next) : null;
      state.nextStartInMs = Number.isFinite(start) ? Math.max(0, start - now) : null;
    } else {
      state.nextStartInMs = null;
    }
  }

  function clearStalePrimaryPreference(markets) {
    const storedId = localStorage.getItem(PRIMARY_STORAGE_KEY);
    if (!storedId) return false;
    if (!shouldIgnoreStoredPrimary(markets, storedId)) return false;
    localStorage.removeItem(PRIMARY_STORAGE_KEY);
    state.selectedMarketId = null;
    return true;
  }

  function setPrimaryMarketLocal(market, meta = {}, options = {}) {
    if (!market?.conditionId) return;
    if (market.conditionId !== state.primaryPoly?.conditionId) {
      state.polyLatest = { yes: null, no: null };
      state.priceToBeat = null;
      state.priceToBeatSource = null;
      state.windowStartTime = null;
    }
    state.selectedMarketId = market.conditionId;
    if (!isFollowLiveWindow() || options.persistPin) {
      localStorage.setItem(PRIMARY_STORAGE_KEY, market.conditionId);
    } else {
      try { localStorage.removeItem(PRIMARY_STORAGE_KEY); } catch (_) {}
    }
    state.primaryPoly = market;
    applyBeatFromMarket(market);
    updatePrimarySelectionMeta(state.activePolyMarkets, market, meta);
  }

  function applyPolymarketMessage(msg) {
    if (msg.type === 'market_selected' && msg.market) {
      setPrimaryMarketLocal(msg.market, msg);
      return;
    }
    if (msg.type === 'market_rolled' && msg.market) {
      setPrimaryMarketLocal(msg.market, msg);
      emit({ source: 'system', type: 'market_rolled', ...msg, timestamp: msg.timestamp || Date.now() });
      return;
    }
    if (msg.type === 'market_details' && msg.market?.conditionId === state.selectedMarketId) {
      setPrimaryMarketLocal({ ...state.primaryPoly, ...msg.market }, msg);
      return;
    }
    if (msg.type === 'markets' && Array.isArray(msg.markets)) {
      if (msg.selectedMode && msg.selectedMode !== state.selectedPolyMode) return;
      if (msg.selectedMarketId) state.selectedMarketId = msg.selectedMarketId;
      const selectedWindow = modeToWindow(state.selectedPolyMode);
      const now = Date.now();
      const deduped = new Map();
      msg.markets.forEach((m) => {
        if (!m?.conditionId) return;
        if (selectedWindow && m.windowMinutes !== selectedWindow) return;
        if (!Number.isFinite(m.endTime) || m.endTime <= now) return;
        deduped.set(m.conditionId, m);
      });
      state.activePolyMarkets = [...deduped.values()].sort((a, b) => {
        const aActive = isWindowActive(a, now);
        const bActive = isWindowActive(b, now);
        if (aActive !== bActive) return aActive ? -1 : 1;
        if (aActive) return a.endTime - b.endTime;
        return (windowStartMs(a) || Infinity) - (windowStartMs(b) || Infinity);
      });
      clearStalePrimaryPreference(state.activePolyMarkets);
      const nextPrimary = pickPrimaryFromMarkets(state.activePolyMarkets, msg.selectedMarketId);
      setPrimaryMarketLocal(nextPrimary, msg);
      return;
    }
    if (msg.type === 'price') {
      const conditionId = msg.market?.conditionId;
      if (conditionId) {
        recordMarketPrices(conditionId, msg.yesPrice, msg.noPrice);
      }
      if (conditionId && (state.portfolio.openPositions || []).some(
        (pos) => positionMarketId(pos) === conditionId
      )) {
        emitPortfolioUpdate('price');
      }
      const selectedWindow = modeToWindow(state.selectedPolyMode);
      const matchesWindow = !selectedWindow || msg.market?.windowMinutes === selectedWindow;
      const matchesMode = !msg.market?.selectedMode || msg.market.selectedMode === state.selectedPolyMode;
      if (!matchesWindow || !matchesMode) return;
      const isPrimary = !state.primaryPoly?.conditionId
        || conditionId === state.primaryPoly.conditionId;
      if (isPrimary) {
        if (Number.isFinite(msg.yesPrice)) state.polyLatest.yes = msg.yesPrice;
        if (Number.isFinite(msg.noPrice)) state.polyLatest.no = msg.noPrice;
        if (msg.via) state.lastPolyVia = msg.via;
        if (msg.market?.question || msg.market?.endTime) {
          state.primaryPoly = { ...state.primaryPoly, ...msg.market };
          applyBeatFromMarket(msg.market);
        }
      }
      return;
    }
    if (msg.type === 'orderbook') {
      if (state.primaryPoly?.conditionId && msg.market?.conditionId !== state.primaryPoly.conditionId) return;
      state.lastOrderbook = msg;
    }
  }

  function applyPortfolioSnapshot(snapshot = {}) {
    const p = state.portfolio;
    if (snapshot.mode) p.mode = snapshot.mode;
    if (Number.isFinite(snapshot.cash)) p.cash = snapshot.cash;
    else if (Number.isFinite(snapshot.bankroll)) p.cash = snapshot.bankroll;
    if (Number.isFinite(snapshot.startingCash)) p.startingCash = snapshot.startingCash;
    else if (Number.isFinite(snapshot.startingBankroll)) p.startingCash = snapshot.startingBankroll;
    if (Number.isFinite(snapshot.netCashDelta)) p.netCashDelta = snapshot.netCashDelta;
    if (Number.isFinite(snapshot.envStartingCash)) p.envStartingCash = snapshot.envStartingCash;
    if (Number.isFinite(snapshot.portfolio)) p.portfolio = snapshot.portfolio;
    if (Number.isFinite(snapshot.realizedPnlTotal)) p.realizedPnlTotal = snapshot.realizedPnlTotal;
    if (Array.isArray(snapshot.openPositions)) {
      p.openPositions = snapshot.openPositions;
      for (const pos of snapshot.openPositions) {
        const id = positionMarketId(pos);
        if (!id || !Number.isFinite(pos.currentPrice)) continue;
        const side = String(pos.side || 'YES').toUpperCase();
        recordMarketPrices(
          id,
          side === 'NO' ? undefined : pos.currentPrice,
          side === 'NO' ? pos.currentPrice : undefined,
        );
      }
    }
    if (Array.isArray(snapshot.tradeHistory)) p.tradeHistory = snapshot.tradeHistory;
    if (Number.isFinite(snapshot.openPositionValue)) p.openPositionValue = snapshot.openPositionValue;
    if (Number.isFinite(snapshot.totalUnrealizedPnl)) p.totalUnrealizedPnl = snapshot.totalUnrealizedPnl;
    if (Number.isFinite(snapshot.totalEquity)) p.totalEquity = snapshot.totalEquity;
    if (Number.isFinite(snapshot.roiPct)) p.roiPct = snapshot.roiPct;
    enrichPortfolioInPlace();
  }

  function applyBotMessage(msg) {
    if (msg.type === 'state') {
      if (typeof msg.running === 'boolean') state.bot.running = msg.running;
      if (typeof msg.mode === 'string') state.bot.mode = msg.mode;
      if (Number.isFinite(msg.cash)) state.bot.cash = msg.cash;
      else if (Number.isFinite(msg.bankroll)) state.bot.cash = msg.bankroll;
      if (msg.runProgress) state.bot.runProgress = msg.runProgress;
    }
    if (Number.isFinite(msg.cashAfter)) state.bot.cash = msg.cashAfter;
    else if (Number.isFinite(msg.bankrollAfter)) state.bot.cash = msg.bankrollAfter;
    else if (Number.isFinite(msg.cashBefore)) state.bot.cash = msg.cashBefore;
    else if (Number.isFinite(msg.bankrollBefore)) state.bot.cash = msg.bankrollBefore;

    if (msg.type === 'portfolio_snapshot') {
      applyPortfolioSnapshot({
        mode: msg.mode,
        cash: msg.cash ?? msg.bankroll,
        startingCash: msg.startingCash ?? msg.startingBankroll,
        netCashDelta: msg.netCashDelta,
        envStartingCash: msg.envStartingCash,
        portfolio: msg.portfolio ?? msg.totalEquity,
        realizedPnlTotal: msg.realizedPnlTotal,
        openPositions: msg.openPositions,
        openPositionValue: msg.openPositionValue,
        totalUnrealizedPnl: msg.totalUnrealizedPnl,
        totalEquity: msg.totalEquity ?? msg.portfolio,
        roiPct: msg.roiPct,
      });
      if (Number.isFinite(msg.cash)) state.portfolio.cash = msg.cash;
      else if (Number.isFinite(msg.bankroll)) state.portfolio.cash = msg.bankroll;
      emitPortfolioUpdate('snapshot');
      return;
    }

    if (msg.type === 'entry' || msg.type === 'exit') {
      const entry = {
        type: msg.type,
        tradeId: msg.tradeId,
        logLine: msg.logLine || msg.detail,
        direction: msg.direction,
        shares: msg.shares,
        entryPrice: msg.entryPrice,
        exitPrice: msg.exitPrice,
        betSize: msg.betSize,
        pnl: msg.pnl,
        question: msg.question,
        windowLabel: msg.windowLabel,
        timestamp: msg.timestamp || Date.now(),
      };
      const historyKey = `${entry.tradeId || ''}:${entry.type}:${entry.timestamp}`;
      const duplicate = state.portfolio.tradeHistory.some((row) =>
        `${row.tradeId || ''}:${row.type}:${row.timestamp}` === historyKey
      );
      if (!duplicate) state.portfolio.tradeHistory.unshift(entry);
      emitPortfolioUpdate(msg.type);
    }
  }

  function handleMessage(msg) {
    if (msg.source === 'system') applySystemMessage(msg);
    if (msg.source === 'polymarket') applyPolymarketMessage(msg);
    if (msg.source === 'bot') applyBotMessage(msg);
    if (msg.source === 'binance' && msg.type === 'price') {
      if (Number.isFinite(msg.price)) state.btcSpot = msg.price;
      if (Number.isFinite(msg.chainlinkPrice)) state.chainlinkSpot = msg.chainlinkPrice;
    }
    if (msg.source === 'binance' && msg.type === 'history' && Array.isArray(msg.history)) {
      state.btcHistory = msg.history.filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.p));
    }
    emit(msg);
  }

  function connectEventStream() {
    if (typeof EventSource === 'undefined') return;
    if (eventSource && eventSource.readyState !== EventSource.CLOSED) return;
    eventSource = new EventSource('/api/events/stream');
    eventSource.onopen = () => emit({ source: 'system', type: 'sse_open', timestamp: Date.now() });
    eventSource.onmessage = (ev) => {
      // Server broadcasts on both WS and SSE; ignore SSE when WS is live to avoid duplicate UI updates.
      if (ws?.readyState === WebSocket.OPEN) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    };
    eventSource.onerror = () => {
      emit({ source: 'system', type: 'sse_error', timestamp: Date.now() });
      eventSource?.close();
      eventSource = null;
      clearTimeout(sseReconnectTimer);
      sseReconnectTimer = setTimeout(connectEventStream, 3000);
    };
  }

  function sendLiveInit() {
    if (!isLivePage() || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      source: 'client',
      type: 'live_init',
      followLive: isFollowLiveWindow(),
      mode: state.selectedPolyMode,
      selectedMarketId: isFollowLiveWindow() ? null : state.selectedMarketId,
      timestamp: Date.now(),
    }));
  }

  function sendFollowLive(enabled) {
    setFollowLiveWindow(enabled);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      source: 'client',
      type: 'follow_live',
      followLive: enabled !== false,
      timestamp: Date.now(),
    }));
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      emit({ source: 'system', type: 'ws_open', timestamp: Date.now() });
      sendLiveInit();
    };
    ws.onclose = () => {
      emit({ source: 'system', type: 'ws_close', timestamp: Date.now() });
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1500);
    };
    ws.onerror = () => emit({ source: 'system', type: 'ws_error', timestamp: Date.now() });
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    };
  }

  async function postJson(url, body = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    return res.json().catch(() => ({}));
  }

  async function refreshInitialState() {
    initLivePagePreferences();
    try {
      const [botResp, modeResp] = await Promise.all([
        fetch('/api/bot/status').then((r) => r.json()),
        fetch('/api/polymarket/mode').then((r) => r.json()),
      ]);
      const storedMode = localStorage.getItem('dashboardPolyMode');
      state.selectedPolyMode = modeResp.selectedPolyMode || botResp.selectedPolyMode || storedMode || state.selectedPolyMode;
      if (storedMode && storedMode !== state.selectedPolyMode) {
        try {
          const sync = await postJson('/api/polymarket/mode', { mode: storedMode });
          state.selectedPolyMode = sync.selectedPolyMode || storedMode;
          if (!isFollowLiveWindow() && sync.selectedMarketId) {
            state.selectedMarketId = sync.selectedMarketId;
            localStorage.setItem(PRIMARY_STORAGE_KEY, sync.selectedMarketId);
          } else {
            state.selectedMarketId = null;
            clearPinnedPrimaryKeys();
          }
        } catch (_) {}
      } else if (isFollowLiveWindow()) {
        state.selectedMarketId = null;
        clearPinnedPrimaryKeys();
      } else {
        state.selectedMarketId = modeResp.selectedMarketId || localStorage.getItem(PRIMARY_STORAGE_KEY) || null;
      }

      try {
        const windowKey = state.selectedPolyMode === 'both' || state.selectedPolyMode === 'all'
          ? '5m'
          : state.selectedPolyMode;
        if (['5m', '15m', '1d'].includes(windowKey)) {
          const marketsResp = await fetch(`/api/markets?window=${encodeURIComponent(windowKey)}`).then((r) => r.json());
          const markets = marketsResp.markets || [];
          clearStalePrimaryPreference(markets);
          const apiPrimary = marketsResp.selectedMarketId;
          if (isFollowLiveWindow()) {
            state.selectedMarketId = apiPrimary || null;
          } else if (apiPrimary && (!state.selectedMarketId || shouldIgnoreStoredPrimary(markets, state.selectedMarketId))) {
            state.selectedMarketId = apiPrimary;
            localStorage.setItem(PRIMARY_STORAGE_KEY, apiPrimary);
          } else if (!state.selectedMarketId && apiPrimary) {
            state.selectedMarketId = apiPrimary;
            localStorage.setItem(PRIMARY_STORAGE_KEY, apiPrimary);
          }
        }
      } catch (_) {}
      state.selectedStrategy = botResp.bot?.strategyId || state.selectedStrategy;
      state.strategies = botResp.strategies || [];
      if (botResp.bot) {
        state.bot.running = Boolean(botResp.bot.running);
        state.bot.mode = botResp.bot.mode || 'paper';
        if (Number.isFinite(botResp.bot.cash)) state.bot.cash = botResp.bot.cash;
        else if (Number.isFinite(botResp.bot.bankroll)) state.bot.cash = botResp.bot.bankroll;
        if (botResp.bot.marketWindow) state.bot.marketWindow = botResp.bot.marketWindow;
        if (botResp.bot.runLimit) state.bot.runLimit = botResp.bot.runLimit;
        if (botResp.bot.runMode) state.bot.runMode = botResp.bot.runMode;
        if (botResp.bot.runProgress) state.bot.runProgress = botResp.bot.runProgress;
      }
      if (botResp.botSession) {
        state.bot.marketWindow = botResp.botSession.marketWindow;
        state.bot.runLimit = botResp.botSession.runLimit;
        if (botResp.botSession.runMode) state.bot.runMode = botResp.botSession.runMode;
      }
      const portfolioResp = await fetch('/api/portfolio').then((r) => r.json()).catch(() => null);
      if (portfolioResp) {
        applyPortfolioSnapshot(portfolioResp);
        emitPortfolioUpdate('init');
      }
      emit({ source: 'system', type: 'init', timestamp: Date.now() });
    } catch (_) {}
  }

  async function setPolyMode(mode) {
    localStorage.setItem('dashboardPolyMode', mode);
    if (isFollowLiveWindow()) {
      clearPinnedPrimaryKeys();
    } else {
      localStorage.removeItem(PRIMARY_STORAGE_KEY);
      state.selectedMarketId = null;
    }
    state.primaryPoly = null;
    state.primaryPhase = null;
    state.hasActiveWindow = true;
    state.showingUpcomingOnly = false;
    state.nextStartInMs = null;
    state.polyLatest = { yes: null, no: null };
    state.priceToBeat = null;
    state.priceToBeatSource = null;
    state.windowStartTime = null;
    const resp = await postJson('/api/polymarket/mode', { mode });
    state.selectedPolyMode = resp.selectedPolyMode || mode;
    if (isFollowLiveWindow()) {
      state.selectedMarketId = resp.selectedMarketId || null;
      clearPinnedPrimaryKeys();
    } else if (resp.selectedMarketId) {
      state.selectedMarketId = resp.selectedMarketId;
      localStorage.setItem(PRIMARY_STORAGE_KEY, resp.selectedMarketId);
    } else {
      localStorage.removeItem(PRIMARY_STORAGE_KEY);
    }
    if (isLivePage()) sendLiveInit();
    emit({ source: 'system', type: 'mode_changed', selectedPolyMode: state.selectedPolyMode, timestamp: Date.now() });
    return resp;
  }

  async function setPrimaryMarket(conditionId) {
    const id = String(conditionId || '').trim();
    if (!id) return null;
    localStorage.setItem(PRIMARY_STORAGE_KEY, id);
    state.selectedMarketId = id;
    const resp = await postJson('/api/markets/select', { conditionId: id });
    if (resp?.market) setPrimaryMarketLocal(resp.market);
    if (resp?.selectedPolyMode) state.selectedPolyMode = resp.selectedPolyMode;
    emit({
      source: 'polymarket',
      type: 'market_selected',
      conditionId: id,
      market: resp?.market,
      timestamp: Date.now(),
    });
    return resp;
  }

  window.Dashboard = {
    subscribe(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    subscribePortfolio(fn) {
      portfolioHandlers.add(fn);
      return () => portfolioHandlers.delete(fn);
    },
    getState: () => state,
    getPortfolio: () => enrichPortfolioInPlace(),
    applyPortfolioSnapshot,
    refreshPortfolio: emitPortfolioUpdate,
    pnlClass(value) {
      if (!Number.isFinite(value) || value === 0) return '';
      return value > 0 ? 'pnl-pos' : 'pnl-neg';
    },
    connect,
    connectEventStream,
    refreshInitialState,
    setPolyMode,
    setPrimaryMarket,
    setFollowLiveWindow,
    isFollowLiveWindow,
    sendFollowLive,
    sendLiveInit,
    clearPinnedPrimaryKeys,
    postJson,
    fmtTs,
    fmtPrice,
    fmtDollars,
    fmtBtcUsd,
    fmtSize,
    fmtCountdown,
    modeToWindow,
    formatWindowMinutes,
    resolvedPolyPrices,
  };

  connect();
  connectEventStream();
  refreshInitialState();
})();
