/**
 * Shared dashboard hub: single WebSocket, subscriber routing, API helpers.
 */
(() => {
  const handlers = new Set();
  let ws = null;
  let reconnectTimer = null;

  const state = {
    selectedPolyMode: '15m',
    selectedStrategy: 'deterministic_yes_50',
    strategies: [],
    feedSource: 'direct',
    lastPolyVia: null,
    binanceConnected: false,
    polymarketConnected: false,
    natsConnected: false,
    bot: { running: false, mode: 'paper', bankroll: Number.NaN },
    activePolyMarkets: [],
    primaryPoly: null,
    polyLatest: { yes: null, no: null },
    lastOrderbook: null,
    btcSpot: null,
    chainlinkSpot: null,
    priceToBeat: null,
    priceToBeatSource: null,
    windowStartTime: null,
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
    return null;
  }

  function resolvedPolyPrices() {
    let yes = state.polyLatest.yes;
    let no = state.polyLatest.no;
    if (Number.isFinite(yes) && !Number.isFinite(no)) no = Math.max(0, Math.min(1, 1 - yes));
    if (Number.isFinite(no) && !Number.isFinite(yes)) yes = Math.max(0, Math.min(1, 1 - no));
    return { yes, no };
  }

  function emit(msg) {
    for (const fn of handlers) {
      try { fn(msg); } catch (_) {}
    }
  }

  function applySystemMessage(msg) {
    if (msg.type === 'hello') {
      if (msg.selectedPolyMode) state.selectedPolyMode = msg.selectedPolyMode;
      if (msg.selectedStrategy) state.selectedStrategy = msg.selectedStrategy;
      if (Array.isArray(msg.strategies)) state.strategies = msg.strategies;
      if (msg.bot) {
        if (typeof msg.bot.running === 'boolean') state.bot.running = msg.bot.running;
        if (Number.isFinite(msg.bot.bankroll)) state.bot.bankroll = msg.bot.bankroll;
        if (msg.bot.strategyId) state.selectedStrategy = msg.bot.strategyId;
      }
      return;
    }
    if (msg.type !== 'status') return;
    if (msg.selectedPolyMode) state.selectedPolyMode = msg.selectedPolyMode;
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
      if (Number.isFinite(msg.bot.bankroll)) state.bot.bankroll = msg.bot.bankroll;
      if (msg.bot.strategyId) state.selectedStrategy = msg.bot.strategyId;
    }
  }

  function applyBeatFromMarket(market) {
    if (!market) return;
    if (Number.isFinite(market.priceToBeat)) state.priceToBeat = market.priceToBeat;
    if (market.priceToBeatSource) state.priceToBeatSource = market.priceToBeatSource;
    if (Number.isFinite(market.windowStartTime)) state.windowStartTime = market.windowStartTime;
  }

  function applyPolymarketMessage(msg) {
    if (msg.type === 'markets' && Array.isArray(msg.markets)) {
      if (msg.selectedMode) state.selectedPolyMode = msg.selectedMode;
      const selectedWindow = modeToWindow(state.selectedPolyMode);
      const now = Date.now();
      const deduped = new Map();
      msg.markets.forEach((m) => {
        if (!m?.conditionId) return;
        if (selectedWindow && m.windowMinutes !== selectedWindow) return;
        if (!Number.isFinite(m.endTime) || m.endTime <= now) return;
        deduped.set(m.conditionId, m);
      });
      state.activePolyMarkets = [...deduped.values()].sort((a, b) => a.endTime - b.endTime);
      const nextPrimary = state.activePolyMarkets[0] || null;
      if (nextPrimary?.conditionId !== state.primaryPoly?.conditionId) {
        state.polyLatest = { yes: null, no: null };
        state.priceToBeat = null;
        state.priceToBeatSource = null;
        state.windowStartTime = null;
      }
      state.primaryPoly = nextPrimary;
      applyBeatFromMarket(nextPrimary);
      return;
    }
    if (msg.type === 'price') {
      const selectedWindow = modeToWindow(state.selectedPolyMode);
      if (selectedWindow && msg.market?.windowMinutes !== selectedWindow) return;
      if (msg.market?.selectedMode && msg.market.selectedMode !== state.selectedPolyMode) return;
      if (state.primaryPoly?.conditionId && msg.market?.conditionId !== state.primaryPoly.conditionId) return;
      if (Number.isFinite(msg.yesPrice)) state.polyLatest.yes = msg.yesPrice;
      if (Number.isFinite(msg.noPrice)) state.polyLatest.no = msg.noPrice;
      if (msg.via) state.lastPolyVia = msg.via;
      if (msg.market?.question || msg.market?.endTime) {
        state.primaryPoly = { ...state.primaryPoly, ...msg.market };
        applyBeatFromMarket(msg.market);
      }
      return;
    }
    if (msg.type === 'orderbook') {
      if (state.primaryPoly?.conditionId && msg.market?.conditionId !== state.primaryPoly.conditionId) return;
      state.lastOrderbook = msg;
    }
  }

  function applyBotMessage(msg) {
    if (msg.type === 'state') {
      if (typeof msg.running === 'boolean') state.bot.running = msg.running;
      if (typeof msg.mode === 'string') state.bot.mode = msg.mode;
      if (Number.isFinite(msg.bankroll)) state.bot.bankroll = msg.bankroll;
    }
    if (Number.isFinite(msg.bankrollAfter)) state.bot.bankroll = msg.bankrollAfter;
    else if (Number.isFinite(msg.bankrollBefore)) state.bot.bankroll = msg.bankrollBefore;
  }

  function handleMessage(msg) {
    if (msg.source === 'system') applySystemMessage(msg);
    if (msg.source === 'polymarket') applyPolymarketMessage(msg);
    if (msg.source === 'bot') applyBotMessage(msg);
    if (msg.source === 'binance' && msg.type === 'price') {
      if (Number.isFinite(msg.price)) state.btcSpot = msg.price;
      if (Number.isFinite(msg.chainlinkPrice)) state.chainlinkSpot = msg.chainlinkPrice;
    }
    emit(msg);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => emit({ source: 'system', type: 'ws_open', timestamp: Date.now() });
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
    try {
      const [botResp, modeResp] = await Promise.all([
        fetch('/api/bot/status').then((r) => r.json()),
        fetch('/api/polymarket/mode').then((r) => r.json()),
      ]);
      const storedMode = localStorage.getItem('dashboardPolyMode');
      state.selectedPolyMode = modeResp.selectedPolyMode || botResp.selectedPolyMode || storedMode || state.selectedPolyMode;
      state.selectedStrategy = botResp.bot?.strategyId || state.selectedStrategy;
      state.strategies = botResp.strategies || [];
      if (botResp.bot) {
        state.bot.running = Boolean(botResp.bot.running);
        state.bot.mode = botResp.bot.mode || 'paper';
        if (Number.isFinite(botResp.bot.bankroll)) state.bot.bankroll = botResp.bot.bankroll;
      }
      emit({ source: 'system', type: 'init', timestamp: Date.now() });
    } catch (_) {}
  }

  async function setPolyMode(mode) {
    localStorage.setItem('dashboardPolyMode', mode);
    const resp = await postJson('/api/polymarket/mode', { mode });
    state.selectedPolyMode = resp.selectedPolyMode || mode;
    emit({ source: 'system', type: 'mode_changed', selectedPolyMode: state.selectedPolyMode, timestamp: Date.now() });
    return resp;
  }

  window.Dashboard = {
    subscribe(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    getState: () => state,
    connect,
    refreshInitialState,
    setPolyMode,
    postJson,
    fmtTs,
    fmtPrice,
    fmtDollars,
    fmtBtcUsd,
    fmtSize,
    fmtCountdown,
    modeToWindow,
    resolvedPolyPrices,
  };

  connect();
  refreshInitialState();
})();
