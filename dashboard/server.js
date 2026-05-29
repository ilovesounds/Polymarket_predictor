/**
 * Live split-view dashboard server.
 * WebSocket fan-out for Polymarket + Binance streams and bot trade events.
 *
 *   npm run dashboard
 *   open http://localhost:3847
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const {
  connectBinanceFeed,
  getBinanceState,
  getChainlinkState,
  pollChainlink,
  fetchBinanceKlineOpen,
} = require('../api/feeds_runtime');
const {
  getActiveBTCShortMarkets,
  listLiveBTCMarketsForWindow,
  getMarketDetails,
  subscribeClobAssets,
  pairYesNoPrices,
  getMidpoint,
  getOrderBook,
  parseWindowStartMs,
} = require('../api/polymarket_runtime');
const { computeAllMarketParams } = require('../signals/marketParams');
const { hub } = require('./hub');
const { buildLabParamsPayload, getLastLabParams } = require('./labParams');
const {
  listPresets,
  savePreset,
  getActivePreset,
  getPresetById,
  setActivePreset,
  defaultPresetFields,
} = require('../lib/strategyLab');
const { sizingSnapshot, resolveSizingConfig } = require('../lib/betSizing');
const { listStrategies, normalizeStrategyId } = require('../signals/strategies_runtime');
const { createNatsBridge } = require('../lib/natsBridge');
const { SUBJECTS } = require('../lib/nats/subjects');
const { toDashboardWire, botStatus, botControl, polymarketTrade } = require('../lib/nats/schemas');
const {
  recordStreamLatency,
  recordTradeDepthPipeline,
  ingestTradePoll,
  getSnapshot,
  onSnapshot,
} = require('../monitoring/latency');
const {
  normalizePolyMode,
  modeToWindows,
  windowMinutesToMode,
  filterLiveMarketsForMode,
  pickPrimaryLiveMarket,
  primaryNeedsRoll,
  isMarketLive,
} = require('../lib/marketSelection');
const {
  revaluePositionRow,
} = require('../paper/portfolio');
const { closeResolvedPositions } = require('../lib/closeResolvedPositions');
const { getRecentResolvedMarkets } = require('../api/polymarket_runtime');
const { normalizeRunLimit } = require('../lib/botRunConfig');
const {
  loadBotProfile,
  saveBotProfile,
  profileToEnv,
  normalizeBotProfile,
} = require('../lib/botProfile');
const {
  appendCashAdjustment,
  resolvePortfolioCashFromAdjustments,
} = require('../lib/cashAdjustments');
const {
  ensureDefaultProfiles,
  listBotProfiles,
  getBotProfileById,
  saveNamedProfile,
  deleteNamedProfile,
  duplicateNamedProfile,
  profileBotFields,
  profileLabPresetFields,
  profileToSpawnEnv,
  previewBetForProfile,
  normalizeNamedProfile,
} = require('../lib/botProfilesStore');
const {
  loadPaperWallet,
  walletToPortfolioState,
  portfolioStateToWallet,
} = require('../lib/paperWallet');
const { previewBetLabel } = require('../lib/betSizing');

const PORT = Number(process.env.DASHBOARD_PORT || 3847);
const STARTING_CASH = Number.parseFloat(
  process.env.STARTING_CASH || process.env.STARTING_BANKROLL || '20'
);
const PORTFOLIO_TRADE_HISTORY_MAX = 500;
const USE_NATS = process.env.USE_NATS !== 'false' && process.env.NATS_URL !== 'disabled';
const USE_NATS_FEEDS = USE_NATS && process.env.USE_NATS_FEEDS === 'true';
const DEBUG_POLY_STREAM = process.env.DEBUG_POLY_STREAM === 'true';
const NATS_FEED_FALLBACK_MS = Number(process.env.NATS_FEED_FALLBACK_MS || 12_000);
const NATS_CONNECT_TIMEOUT_MS = Number(process.env.NATS_CONNECT_TIMEOUT_MS || 8_000);
const POLY_WS_THROTTLE_MS = Number(process.env.POLY_WS_THROTTLE_MS || 250);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MARKET_REFRESH_MS = Number(process.env.MARKET_REFRESH_MS || 45_000);
const MARKET_ROLL_CHECK_MS = Number(process.env.MARKET_ROLL_CHECK_MS || 5_000);
const MIDPOINT_FALLBACK_MS = 5_000;
const ORDERBOOK_POLL_MS = 2_500;
const BOT_STOP_TIMEOUT_MS = 6_000;
const ROOT_DIR = path.join(__dirname, '..');

const clients = new Set();
/** @type {Set<import('http').ServerResponse>} */
const sseClients = new Set();
const polySubscriptions = new Map(); // key: conditionId:yes|no

let binanceConnected = false;
let polymarketConnected = false;
let selectedPolyMode = String(process.env.DASHBOARD_POLY_MODE || '15m');
let selectedPrimaryMarketId = null;
let lastMarkets = [];
let lastMarketDetails = null;
let polySubscriptionCycle = 0;
let botProcess = null;
let botStopPromise = null;
let botLifecycle = Promise.resolve();
let botProfile = loadBotProfile(process.env);
ensureDefaultProfiles();
let activeProfileId = process.env.BOT_PROFILE_ID || 'default';
let selectedStrategy = botProfile.strategyId;
let selectedBotMarketWindow = botProfile.marketWindow;
let botRunLimit = { ...botProfile.runLimit };
let orderbookPollingTimer = null;
const strategyOptions = listStrategies();
let natsBridge = null;
let natsConnected = false;
let natsConnectFailed = false;
let natsBridgeInit = null;

function getNatsBridge() {
  if (!USE_NATS) return null;
  if (!natsBridge) {
    natsBridge = createNatsBridge({
      name: 'dashboard',
      connectTimeoutMs: NATS_CONNECT_TIMEOUT_MS,
    });
  }
  return natsBridge;
}
let directFeedsStarted = false;
let lastPolyVia = null;
let polyStreamStats = { ws: 0, midpoint: 0, orderbook: 0, trades: 0, lastAt: 0 };
const recentTradeKeys = new Set();
const RECENT_TRADE_KEY_MAX = 500;
const recentBotEventKeys = new Set();
const RECENT_BOT_EVENT_KEY_MAX = 1000;
let lastPolyWsEmitAt = 0;
/** @type {Map<string, { priceToBeat: number, windowStartTime: number, priceToBeatSource: string }>} */
const priceToBeatCache = new Map();
let chainlinkPollTimer = null;

const initialCashState = resolvePortfolioCashFromAdjustments(STARTING_CASH);
const botState = {
  running: false,
  pid: null,
  mode: 'paper',
  cash: initialCashState.cash,
  profileId: null,
  startedAt: null,
  stoppedAt: null,
  lastExitCode: null,
  logs: [],
};

const portfolioState = {
  mode: 'paper',
  cash: initialCashState.cash,
  startingCash: initialCashState.startingCash,
  netCashDelta: initialCashState.netCashDelta,
  realizedPnlTotal: 0,
  openPositions: [],
  tradeHistory: [],
  updatedAt: null,
  profileId: activeProfileId,
};

function loadPortfolioForProfile(profileId) {
  const id = profileId || activeProfileId || 'default';
  const wallet = loadPaperWallet(id, STARTING_CASH);
  const state = walletToPortfolioState(wallet);
  portfolioState.cash = state.cash;
  portfolioState.startingCash = state.startingCash;
  portfolioState.netCashDelta = state.netCashDelta;
  portfolioState.realizedPnlTotal = state.realizedPnlTotal;
  portfolioState.openPositions = state.openPositions;
  portfolioState.tradeHistory = state.tradeHistory;
  portfolioState.updatedAt = state.updatedAt;
  portfolioState.profileId = id;
  activeProfileId = id;
  botState.cash = portfolioState.cash;
}

function persistActiveProfileWallet() {
  const id = botState.running ? (botState.profileId || activeProfileId) : activeProfileId;
  if (!id) return;
  portfolioStateToWallet(id, portfolioState);
}

function applyNamedProfileToSession(profile) {
  if (!profile) return null;
  applyBotProfile(profileBotFields(profile), { persist: false });
  setActivePreset(profileLabPresetFields(profile));
  activeProfileId = profile.id;
  loadPortfolioForProfile(profile.id);
  return profile;
}

function pickSizingBody(body = {}) {
  const out = {};
  if (body.sizingMode != null) out.sizingMode = body.sizingMode;
  if (body.fixedBetUsd != null) out.fixedBetUsd = body.fixedBetUsd;
  if (body.betPercent != null) out.betPercent = body.betPercent;
  if (body.kellyFractionCap != null) out.kellyFractionCap = body.kellyFractionCap;
  if (body.defaultWinRate != null) out.defaultWinRate = body.defaultWinRate;
  if (body.cashFraction != null) out.cashFraction = body.cashFraction;
  return out;
}

loadPortfolioForProfile(activeProfileId);

function resolveCashFromBody(body) {
  if (Number.isFinite(body.cash)) return body.cash;
  if (Number.isFinite(body.bankroll)) return body.bankroll;
  return null;
}

function resolveStartingCashFromBody(body) {
  if (Number.isFinite(body.startingCash)) return body.startingCash;
  if (Number.isFinite(body.startingBankroll)) return body.startingBankroll;
  return null;
}

/** Latest YES mid per market — used to mark open bot positions between snapshots. */
const marketYesPriceCache = new Map();

selectedPolyMode = normalizePolyMode(selectedPolyMode);

function rememberMarketYesPrice(marketId, yesPrice) {
  if (!marketId || !Number.isFinite(yesPrice)) return;
  marketYesPriceCache.set(marketId, { price: yesPrice, ts: Date.now() });
}

function cacheYesPricesFromPositions(positions = []) {
  for (const pos of positions) {
    if (pos.marketId && Number.isFinite(pos.currentPrice)) {
      rememberMarketYesPrice(pos.marketId, pos.currentPrice);
    }
  }
}

function revalueOpenPositionsFromCache() {
  const positions = portfolioState.openPositions || [];
  if (!positions.length) return false;
  let changed = false;
  const next = positions.map((pos) => {
    const cached = pos.marketId ? marketYesPriceCache.get(pos.marketId) : null;
    if (!cached || !Number.isFinite(cached.price)) return pos;
    const row = revaluePositionRow(pos, cached.price);
    if (row.currentPrice !== pos.currentPrice || row.unrealizedPnl !== pos.unrealizedPnl) {
      changed = true;
    }
    return row;
  });
  if (changed) portfolioState.openPositions = next;
  return changed;
}

function mergeEntryOpenPosition(row, body) {
  const existing = portfolioState.openPositions.find((pos) =>
    (body.tradeId && pos.tradeId === body.tradeId)
    || (body.marketId && pos.marketId === body.marketId)
  );
  if (!existing) return row;
  const entryPrice = row.entryPrice ?? existing.entryPrice;
  const bodyMark = Number.isFinite(row.currentPrice) && Number.isFinite(entryPrice)
    && row.currentPrice === entryPrice;
  const liveExisting = Number.isFinite(existing.currentPrice)
    && Number.isFinite(existing.entryPrice)
    && existing.currentPrice !== existing.entryPrice;
  if (!bodyMark || !liveExisting) return { ...existing, ...row };
  return {
    ...existing,
    ...row,
    currentPrice: existing.currentPrice,
    currentValue: existing.currentValue,
    unrealizedPnl: existing.unrealizedPnl,
  };
}

function portfolioSnapshot() {
  revalueOpenPositionsFromCache();
  const openPositions = portfolioState.openPositions || [];
  let openPositionValue = 0;
  let totalUnrealizedPnl = 0;
  for (const pos of openPositions) {
    if (Number.isFinite(pos.currentValue)) openPositionValue += pos.currentValue;
    if (Number.isFinite(pos.unrealizedPnl)) totalUnrealizedPnl += pos.unrealizedPnl;
  }
  const cash = portfolioState.cash;
  const startingCash = portfolioState.startingCash;
  const portfolio = cash + openPositionValue;
  const roiPct = Number.isFinite(startingCash) && startingCash > 0
    ? ((portfolio - startingCash) / startingCash) * 100
    : null;

  return {
    mode: portfolioState.mode,
    cash,
    startingCash,
    netCashDelta: portfolioState.netCashDelta ?? 0,
    envStartingCash: STARTING_CASH,
    portfolio,
    realizedPnlTotal: portfolioState.realizedPnlTotal,
    openPositions,
    openPositionCount: openPositions.length,
    openPositionValue,
    totalUnrealizedPnl,
    totalEquity: portfolio,
    roiPct,
    tradeHistory: portfolioState.tradeHistory,
    updatedAt: portfolioState.updatedAt,
    profileId: activeProfileId,
    bot: {
      running: botState.running,
      mode: botState.mode,
      strategyId: selectedStrategy,
      profileId: botState.profileId || activeProfileId,
    },
  };
}

function rememberTradeHistory(entry) {
  const key = `${entry.tradeId || ''}:${entry.type}:${entry.timestamp}`;
  if (key !== '::' && portfolioState.tradeHistory.some((row) =>
    `${row.tradeId || ''}:${row.type}:${row.timestamp}` === key
  )) {
    return;
  }
  portfolioState.tradeHistory.unshift(entry);
  if (portfolioState.tradeHistory.length > PORTFOLIO_TRADE_HISTORY_MAX) {
    portfolioState.tradeHistory.length = PORTFOLIO_TRADE_HISTORY_MAX;
  }
}

function botEventDedupeKey(body = {}) {
  const eventType = body.type || body.eventType;
  if (eventType === 'entry' || eventType === 'exit') {
    return `${eventType}:${body.tradeId || ''}:${body.timestamp || body.ts || ''}`;
  }
  return null;
}

function rememberBotEventKey(key) {
  if (!key) return false;
  if (recentBotEventKeys.has(key)) return true;
  recentBotEventKeys.add(key);
  if (recentBotEventKeys.size > RECENT_BOT_EVENT_KEY_MAX) {
    const drop = recentBotEventKeys.size - RECENT_BOT_EVENT_KEY_MAX;
    let i = 0;
    for (const k of recentBotEventKeys) {
      recentBotEventKeys.delete(k);
      if (++i >= drop) break;
    }
  }
  return false;
}

function applyPortfolioEvent(body = {}) {
  if (body.mode === 'paper' || body.mode === 'live') portfolioState.mode = body.mode;
  const cash = resolveCashFromBody(body);
  if (Number.isFinite(cash)) {
    portfolioState.cash = cash;
    botState.cash = cash;
  }
  const startingCash = resolveStartingCashFromBody(body);
  if (Number.isFinite(startingCash)) portfolioState.startingCash = startingCash;
  if (Number.isFinite(body.realizedPnlTotal)) portfolioState.realizedPnlTotal = body.realizedPnlTotal;
  if (Array.isArray(body.openPositions)) {
    portfolioState.openPositions = body.openPositions;
    cacheYesPricesFromPositions(body.openPositions);
  }
  portfolioState.updatedAt = body.timestamp || Date.now();

  const eventType = body.type || body.eventType;
  if (eventType === 'entry') {
    const row = mergeEntryOpenPosition({
      tradeId: body.tradeId || null,
      marketId: body.marketId || null,
      question: body.question || null,
      windowMinutes: body.windowMinutes ?? null,
      windowLabel: body.windowLabel || null,
      side: body.direction || 'YES',
      shares: body.shares ?? null,
      entryPrice: body.entryPrice ?? null,
      costBasis: body.costBasis ?? body.betSize ?? null,
      currentPrice: body.currentPrice ?? body.entryPrice ?? null,
      currentValue: body.currentValue ?? body.betSize ?? null,
      unrealizedPnl: Number.isFinite(body.unrealizedPnl) ? body.unrealizedPnl : 0,
      entryTime: body.entryTime || body.timestamp || Date.now(),
    }, body);
    if (row.marketId && Number.isFinite(row.currentPrice)) {
      rememberMarketYesPrice(row.marketId, row.currentPrice);
    }
    portfolioState.openPositions = [
      row,
      ...portfolioState.openPositions.filter((pos) =>
        !(body.tradeId && pos.tradeId === body.tradeId)
        && !(body.marketId && pos.marketId === body.marketId)
      ),
    ];
    const cashAfterEntry = Number.isFinite(body.cashAfter) ? body.cashAfter : body.bankrollAfter;
    if (Number.isFinite(cashAfterEntry)) {
      portfolioState.cash = cashAfterEntry;
      botState.cash = cashAfterEntry;
    }
  }
  if (eventType === 'exit') {
    if (Number.isFinite(body.pnl)) {
      portfolioState.realizedPnlTotal += body.pnl;
    }
    const cashAfter = Number.isFinite(body.cashAfter) ? body.cashAfter : body.bankrollAfter;
    if (Number.isFinite(cashAfter)) {
      portfolioState.cash = cashAfter;
      botState.cash = cashAfter;
    }
    portfolioState.openPositions = portfolioState.openPositions.filter((pos) => {
      if (body.tradeId && pos.tradeId === body.tradeId) return false;
      if (body.marketId && pos.marketId === body.marketId) return false;
      return true;
    });
  }
  if (eventType === 'entry' || eventType === 'exit') {
    rememberTradeHistory({
      type: eventType,
      tradeId: body.tradeId || null,
      logLine: body.logLine || body.detail || null,
      direction: body.direction || null,
      shares: body.shares ?? null,
      entryPrice: body.entryPrice ?? null,
      exitPrice: body.exitPrice ?? null,
      betSize: body.betSize ?? null,
      pnl: body.pnl ?? null,
      won: typeof body.won === 'boolean' ? body.won : null,
      exitReason: body.exitReason ?? null,
      resolvedOutcome: body.resolvedOutcome ?? null,
      question: body.question || null,
      windowMinutes: body.windowMinutes ?? null,
      windowLabel: body.windowLabel || null,
      marketId: body.marketId || null,
      cashAfter: body.cashAfter ?? body.bankrollAfter ?? null,
      timestamp: body.timestamp || Date.now(),
    });
  }
  persistActiveProfileWallet();
}

function resetPortfolioSession(profileId = activeProfileId) {
  loadPortfolioForProfile(profileId || 'default');
}

function parseCashAdjustmentRequest(body = {}) {
  let delta = null;
  if (Number.isFinite(body.delta)) {
    delta = body.delta;
  } else if (body.action === 'add' && Number.isFinite(body.amount)) {
    delta = Math.abs(body.amount);
  } else if (body.action === 'remove' && Number.isFinite(body.amount)) {
    delta = -Math.abs(body.amount);
  }
  if (!Number.isFinite(delta) || delta === 0) {
    return { error: 'Provide delta or action add/remove with amount' };
  }
  return {
    delta,
    updateBaseline: Boolean(body.updateBaseline),
    note: typeof body.note === 'string' ? body.note : null,
  };
}

function applyPortfolioCashAdjustment({ delta, updateBaseline = false, note = null }) {
  if (portfolioState.mode !== 'paper') {
    return { ok: false, statusCode: 403, error: 'Cash adjustments are paper-mode only' };
  }
  const nextCash = Math.round((portfolioState.cash + delta) * 100) / 100;
  if (delta < 0 && nextCash < 0) {
    return {
      ok: false,
      statusCode: 400,
      error: `Cannot remove $${Math.abs(delta).toFixed(2)} — only $${portfolioState.cash.toFixed(2)} liquid cash available`,
    };
  }
  const saved = appendCashAdjustment({
    delta,
    updateBaseline,
    note,
    envStartingCash: STARTING_CASH,
  });
  portfolioState.cash = nextCash;
  portfolioState.netCashDelta = saved.netCashDelta;
  if (updateBaseline && delta > 0) {
    portfolioState.startingCash = saved.startingCashBaseline ?? portfolioState.startingCash;
  } else if (Number.isFinite(saved.startingCashBaseline)) {
    portfolioState.startingCash = saved.startingCashBaseline;
  }
  portfolioState.updatedAt = Date.now();
  botState.cash = portfolioState.cash;
  persistActiveProfileWallet();
  const snapshot = broadcastPortfolio({
    cashAdjustment: { delta, updateBaseline, note },
  });
  return { ok: true, statusCode: 200, snapshot, netCashDelta: saved.netCashDelta };
}

function broadcastPortfolio(extra = {}) {
  const payload = {
    source: 'bot',
    type: 'portfolio_snapshot',
    timestamp: Date.now(),
    ...portfolioSnapshot(),
    ...extra,
  };
  broadcast(payload);
  return payload;
}

function ingestBotEvent(body = {}) {
  const dedupeKey = botEventDedupeKey(body);
  if (dedupeKey && rememberBotEventKey(dedupeKey)) return null;

  if (body.type === 'portfolio_snapshot' || body.eventType === 'portfolio_snapshot') {
    applyPortfolioEvent(body);
    return broadcastPortfolio();
  }

  if (body.type === 'entry' || body.type === 'exit' || body.eventType === 'entry' || body.eventType === 'exit') {
    applyPortfolioEvent(body);
    if (body.latencyTiming && (body.type === 'entry' || body.eventType === 'entry')) {
      recordTradeDepthPipeline(body.latencyTiming);
    }
    const cashAfterEvt = Number.isFinite(body.cashAfter) ? body.cashAfter : body.bankrollAfter;
    const cashBeforeEvt = Number.isFinite(body.cashBefore) ? body.cashBefore : body.bankrollBefore;
    if (Number.isFinite(cashAfterEvt)) {
      botState.cash = cashAfterEvt;
    } else if (Number.isFinite(cashBeforeEvt)) {
      botState.cash = cashBeforeEvt;
    }
    const payload = { source: 'bot', timestamp: Date.now(), ...body };
    broadcast(payload);
    broadcast({
      source: 'bot',
      type: 'state',
      timestamp: Date.now(),
      cash: botState.cash,
      running: botState.running,
      mode: botState.mode,
      pid: botState.pid,
    });
    broadcastPortfolio();
    sendStatus();
    return payload;
  }

  const cashAfterIngest = Number.isFinite(body.cashAfter) ? body.cashAfter : body.bankrollAfter;
  const cashBeforeIngest = Number.isFinite(body.cashBefore) ? body.cashBefore : body.bankrollBefore;
  if (Number.isFinite(cashAfterIngest)) {
    botState.cash = cashAfterIngest;
    portfolioState.cash = cashAfterIngest;
  } else if (Number.isFinite(cashBeforeIngest)) {
    botState.cash = cashBeforeIngest;
    portfolioState.cash = cashBeforeIngest;
  }

  const payload = { source: 'bot', timestamp: Date.now(), ...body };
  broadcast(payload);
  return payload;
}

function broadcastSse(payload) {
  if (!sseClients.size) return;
  const raw = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(raw);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

function broadcast(payload) {
  const raw = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
  broadcastSse(payload);
}

function debugPoly(...args) {
  if (DEBUG_POLY_STREAM) console.log('[poly-stream]', ...args);
}

function rememberTradeKey(key) {
  if (!key) return false;
  if (recentTradeKeys.has(key)) return true;
  recentTradeKeys.add(key);
  if (recentTradeKeys.size > RECENT_TRADE_KEY_MAX) {
    const drop = recentTradeKeys.size - RECENT_TRADE_KEY_MAX;
    let i = 0;
    for (const k of recentTradeKeys) {
      recentTradeKeys.delete(k);
      if (++i >= drop) break;
    }
  }
  return false;
}

function emitPolymarketTrade(market, trade, via = 'clob_ws') {
  if (!trade?.side) return;
  if (rememberTradeKey(trade.tradeKey)) return;

  polymarketConnected = true;
  polyStreamStats.trades += 1;
  polyStreamStats.lastAt = Date.now();
  recordStreamLatency('poly_ws_trade', {
    sourceTs: trade.ts_ms,
    receivedTs: Date.now(),
    meta: { side: trade.side, price: trade.price },
  });

  const payload = {
    source: 'polymarket',
    type: 'trade',
    side: trade.side,
    size: trade.size,
    price: trade.price,
    usdc: trade.usdc,
    ts_ms: trade.ts_ms,
    clobSide: trade.clobSide,
    taker: trade.taker,
    via,
    tradeKey: trade.tradeKey,
    market: {
      conditionId: market.conditionId,
      question: market.question,
      windowMinutes: market.windowMinutes,
      endTime: market.endTime,
      selectedMode: selectedPolyMode,
      isPrimary: true,
    },
    timestamp: trade.ts_ms,
  };

  broadcast(payload);
  if (natsConnected && natsBridge) {
    natsBridge.publish(
      SUBJECTS.FEEDS_POLYMARKET_TRADES,
      polymarketTrade({
        ...trade,
        market: payload.market,
        via,
      })
    ).catch(() => {});
  }
  debugPoly('trade', trade.side, trade.clobSide, trade.usdc?.toFixed(2), '@', trade.price);
}

function sendStatus() {
  const payload = {
    source: 'system',
    type: 'status',
    timestamp: Date.now(),
    binanceConnected,
    polymarketConnected,
    natsConnected,
    feedSource: USE_NATS_FEEDS
      ? (directFeedsStarted ? 'nats+direct' : 'nats')
      : 'direct',
    lastPolyVia,
    polyStreamStats: DEBUG_POLY_STREAM ? { ...polyStreamStats } : undefined,
    selectedPolyMode,
    selectedMarketId: selectedPrimaryMarketId,
    clientCount: clients.size,
    bot: {
      running: botState.running,
      pid: botState.pid,
      mode: botState.mode,
      strategyId: selectedStrategy,
      cash: botState.cash,
      startedAt: botState.startedAt,
      stoppedAt: botState.stoppedAt,
      lastExitCode: botState.lastExitCode,
      profileId: botState.profileId || activeProfileId,
      ...botSessionSnapshot(),
    },
  };
  broadcast(payload);
  if (natsConnected && natsBridge) {
    natsBridge.publish(
      SUBJECTS.BOT_STATUS,
      botStatus({
        running: botState.running,
        pid: botState.pid,
        mode: botState.mode,
        strategyId: selectedStrategy,
        cash: botState.cash,
        startedAt: botState.startedAt,
        stoppedAt: botState.stoppedAt,
        lastExitCode: botState.lastExitCode,
        binanceConnected,
        polymarketConnected,
        selectedPolyMode,
        clientCount: clients.size,
      })
    ).catch(() => {});
  }
}

async function publishBotControl(command, extra = {}) {
  if (!USE_NATS || natsConnectFailed || !natsConnected) return;
  const bridge = getNatsBridge();
  if (!bridge) return;
  await bridge.publish(
    SUBJECTS.BOT_CONTROL,
    botControl({ command, ...extra, requestId: `${Date.now()}` })
  ).catch(() => {});
}

function enqueueBotLifecycle(fn) {
  const run = botLifecycle.then(fn);
  botLifecycle = run.catch(() => {});
  return run;
}

function bridgeNatsMessage(subject, msg) {
  const wire = toDashboardWire(subject, msg);
  if (!wire) return;

  if (wire.source === 'binance' && wire.type === 'price') binanceConnected = true;
  if (wire.source === 'polymarket') polymarketConnected = true;

  if (wire.source === 'bot' && wire.type === 'log') {
    botState.logs.unshift(wire);
    if (botState.logs.length > 250) botState.logs.pop();
    broadcast(wire);
    return;
  }

  if (wire.source === 'bot' && wire.type !== 'control') {
    if (wire.type === 'state') {
      const wireCash = Number.isFinite(wire.cash) ? wire.cash : wire.bankroll;
      if (Number.isFinite(wireCash)) {
        botState.cash = wireCash;
        portfolioState.cash = wireCash;
      }
      if (typeof wire.running === 'boolean') botState.running = wire.running;
    }
    if (['entry', 'exit', 'portfolio_snapshot', 'state'].includes(wire.type)
      || wire.eventType === 'portfolio_snapshot') {
      ingestBotEvent(wire);
      return;
    }
    const wireCashAfter = Number.isFinite(wire.cashAfter) ? wire.cashAfter : wire.bankrollAfter;
    if (Number.isFinite(wireCashAfter)) {
      botState.cash = wireCashAfter;
      portfolioState.cash = wireCashAfter;
    }
  }

  broadcast(wire);
}

function mimeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const PAGE_ROUTES = {
  '/': '/live.html',
  '/live': '/live.html',
  '/orderbook': '/orderbook.html',
  '/bot': '/bot.html',
  '/portfolio': '/portfolio.html',
  '/markets': '/markets.html',
  '/backtest': '/backtest.html',
  '/lab': '/lab.html',
  '/strategy': '/lab.html',
  '/docs': '/docs/index.html',
  '/latency': '/latency.html',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (PAGE_ROUTES[urlPath]) urlPath = PAGE_ROUTES[urlPath];
  const rel = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeFor(filePath) });
    res.end(data);
  });
}

function closePolySubscriptions() {
  for (const handle of polySubscriptions.values()) {
    try {
      if (typeof handle?.close === 'function') handle.close();
      else handle?.close?.();
    } catch (_) {}
  }
  polySubscriptions.clear();
}

function marketWireFields(m) {
  return {
    conditionId: m.conditionId,
    question: m.question,
    windowMinutes: m.windowMinutes,
    endTime: m.endTime,
    slug: m.slug,
    tokenIdYes: m.tokenIdYes,
    tokenIdNo: m.tokenIdNo,
    windowStartTime: m.windowStartTime ?? parseWindowStartMs(m) ?? undefined,
    priceToBeat: m.priceToBeat,
    priceToBeatSource: m.priceToBeatSource,
    liquidity: m.liquidity,
    volume24h: m.volume24h,
    outcomePrices: m.outcomePrices,
    active: m.active,
    closed: m.closed,
    isPrimary: m.conditionId === selectedPrimaryMarketId,
  };
}

function syncPrimaryMarketId(preferredId = selectedPrimaryMarketId) {
  lastMarkets = filterLiveMarketsForMode(lastMarkets, selectedPolyMode);
  const primary = pickPrimaryLiveMarket(lastMarkets, selectedPolyMode, preferredId);
  if (primary) selectedPrimaryMarketId = primary.conditionId;
  else selectedPrimaryMarketId = null;
  return primary;
}

function getPrimaryMarket() {
  if (!lastMarkets.length) return null;
  return pickPrimaryLiveMarket(lastMarkets, selectedPolyMode, selectedPrimaryMarketId);
}

function windowQueryToKey(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === '5' || v === '5m') return '5m';
  if (v === '15' || v === '15m') return '15m';
  if (v === '1d' || v === 'daily' || v === '1440') return '1d';
  return null;
}

async function buildMarketDetailPayload(conditionId) {
  const detail = await getMarketDetails(conditionId);
  if (!detail) return null;

  const beat = await resolvePriceToBeat(detail);
  const enriched = beat ? { ...detail, ...beat } : detail;

  let yesPrice = null;
  let noPrice = null;
  let marketParams = null;
  try {
    const [yesMid, noMid, yesBook] = await Promise.all([
      detail.tokenIdYes ? getMidpoint(detail.tokenIdYes).catch(() => null) : null,
      detail.tokenIdNo ? getMidpoint(detail.tokenIdNo).catch(() => null) : null,
      detail.tokenIdYes ? getOrderBook(detail.tokenIdYes).catch(() => null) : null,
    ]);
    const paired = pairYesNoPrices(yesMid, noMid);
    yesPrice = paired.yes;
    noPrice = paired.no;
    if (yesBook) {
      const { params } = computeAllMarketParams(yesBook, { marketMeta: enriched });
      marketParams = params;
    }
  } catch (_) {}

  const binance = getBinanceState().price;
  const spot = Number.isFinite(binance) ? binance : null;
  const btcDelta = Number.isFinite(enriched.priceToBeat) && Number.isFinite(spot)
    ? spot - enriched.priceToBeat
    : null;

  return {
    market: enriched,
    live: { yesPrice, noPrice, btcSpot: spot, btcDelta },
    marketParams,
    polymarketUrl: enriched.polymarketUrl || (enriched.slug ? `https://polymarket.com/event/${enriched.slug}` : null),
    timestamp: Date.now(),
  };
}

async function broadcastMarketDetails(conditionId) {
  const payload = await buildMarketDetailPayload(conditionId);
  if (!payload) return null;
  lastMarketDetails = payload;
  broadcast({
    source: 'polymarket',
    type: 'market_details',
    ...payload,
  });
  return payload;
}

async function setPrimaryMarket(conditionId, options = {}) {
  const id = String(conditionId || '').trim();
  if (!id) return { ok: false, error: 'conditionId required' };

  let detail = await getMarketDetails(id);
  if (!detail) return { ok: false, error: 'Market not found' };

  const windowMinutes = detail.windowMinutes;
  const windowKey = windowMinutesToMode(windowMinutes) || '15m';

  if (!isMarketLive(detail)) {
    const liveSeries = await listLiveBTCMarketsForWindow(windowKey);
    const nextLive = pickPrimaryLiveMarket(liveSeries, [windowMinutes]);
    if (!nextLive) {
      return { ok: false, error: 'Market resolved and no live market available in this series' };
    }
    detail = nextLive;
  }

  const beat = await resolvePriceToBeat(detail);
  if (beat) detail = { ...detail, ...beat };

  selectedPrimaryMarketId = detail.conditionId;

  if (options.syncMode !== false) {
    const nextMode = normalizePolyMode(windowKey);
    if (nextMode !== selectedPolyMode && ['5m', '15m', '1d'].includes(nextMode)) {
      selectedPolyMode = nextMode;
    }
  }

  lastMarkets = filterLiveMarketsForMode([detail, ...lastMarkets], selectedPolyMode);
  const primary = syncPrimaryMarketId(detail.conditionId);
  if (primary) detail = primary;

  if (!USE_NATS_FEEDS) {
    await subscribePolymarketMarkets();
  } else {
    broadcast({
      source: 'polymarket',
      type: 'market_selected',
      conditionId: detail.conditionId,
      selectedMode: selectedPolyMode,
      market: marketWireFields(detail),
      timestamp: Date.now(),
    });
    await broadcastMarketDetails(detail.conditionId);
    sendStatus();
  }

  return {
    ok: true,
    market: marketWireFields(detail),
    selectedPolyMode,
    selectedMarketId: detail.conditionId,
    rolledFrom: id !== detail.conditionId ? id : undefined,
  };
}

async function resolvePriceToBeat(market) {
  const windowStartTime = parseWindowStartMs(market);
  if (!Number.isFinite(windowStartTime)) return null;

  const cached = priceToBeatCache.get(market.conditionId);
  if (cached?.windowStartTime === windowStartTime && Number.isFinite(cached.priceToBeat)) {
    return cached;
  }

  const ageMs = Date.now() - windowStartTime;
  let priceToBeat = null;
  let priceToBeatSource = null;

  if (ageMs >= 0 && ageMs < 20_000) {
    const snap = getBinanceState().price;
    if (Number.isFinite(snap)) {
      priceToBeat = snap;
      priceToBeatSource = 'binance_snapshot';
    }
  }

  if (!Number.isFinite(priceToBeat)) {
    try {
      priceToBeat = await fetchBinanceKlineOpen(windowStartTime);
      priceToBeatSource = 'binance_kline';
    } catch (e) {
      debugPoly('priceToBeat fetch failed', e.message);
    }
  }

  if (!Number.isFinite(priceToBeat)) return null;

  const entry = { priceToBeat, windowStartTime, priceToBeatSource };
  priceToBeatCache.set(market.conditionId, entry);
  return entry;
}

async function enrichMarketsWithBeat(markets) {
  const out = [];
  for (const m of markets) {
    const beat = await resolvePriceToBeat(m);
    out.push(beat ? { ...m, ...beat } : m);
  }
  return out;
}

function filterAndRankMarkets(markets, mode) {
  return filterLiveMarketsForMode(markets, mode);
}

function makeBotLogLine(text, level = 'info') {
  const line = {
    source: 'bot',
    type: 'log',
    level,
    message: text.slice(0, 4000),
    timestamp: Date.now(),
  };
  botState.logs.unshift(line);
  if (botState.logs.length > 250) botState.logs.pop();
  return line;
}

function handleBotOutput(chunk, level = 'info') {
  const data = String(chunk || '');
  if (!data.trim()) return;
  const lines = data.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const money = line.match(/cash=\$([0-9]+(?:\.[0-9]+)?)/i)
      || line.match(/cash:\s*\$?([0-9]+(?:\.[0-9]+)?)/i)
      || line.match(/bankroll=\$([0-9]+(?:\.[0-9]+)?)/i)
      || line.match(/bankroll:\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
    if (money) {
      const val = Number.parseFloat(money[1]);
      if (Number.isFinite(val)) {
        botState.cash = val;
        portfolioState.cash = val;
        broadcast({
          source: 'bot',
          type: 'state',
          timestamp: Date.now(),
          cash: botState.cash,
          running: botState.running,
          mode: botState.mode,
          pid: botState.pid,
        });
      }
    }
    broadcast(makeBotLogLine(line, level));
  }
}

function setupBotProcessHandlers(child) {
  child.stdout?.on('data', (chunk) => handleBotOutput(chunk, 'info'));
  child.stderr?.on('data', (chunk) => handleBotOutput(chunk, 'error'));
  child.on('exit', (code, signal) => {
    botState.running = false;
    botState.pid = null;
    botState.stoppedAt = Date.now();
    botState.lastExitCode = Number.isInteger(code) ? code : null;
    botProcess = null;
    portfolioState.openPositions = [];
    portfolioState.updatedAt = Date.now();
    broadcast(makeBotLogLine(`Bot exited (code=${code ?? 'null'}, signal=${signal || 'none'})`, 'warn'));
    broadcastPortfolio();
    sendStatus();
  });
}

function summarizeBookLevels(levels = [], side = 'bid') {
  const sorted = [...levels]
    .filter((lvl) => Number.isFinite(lvl[0]) && Number.isFinite(lvl[1]))
    .sort((a, b) => (side === 'bid' ? b[0] - a[0] : a[0] - b[0]));
  const ladder = sorted.slice(0, 10).map(([price, size]) => ({
    price: Number(price),
    size: Number(size),
  }));
  const totalDepth = sorted.reduce((sum, [, size]) => sum + size, 0);
  return {
    best: ladder[0] || null,
    depthTop5: ladder.slice(0, 5).reduce((sum, row) => sum + row.size, 0),
    totalDepth,
    ladder,
  };
}

async function publishOrderbookSnapshot() {
  const pollStart = Date.now();
  const market = getPrimaryMarket();
  if (!market?.tokenIdYes && !market?.tokenIdNo) return;
  try {
    const [yesBook, noBook] = await Promise.all([
      market.tokenIdYes ? getOrderBook(market.tokenIdYes).catch(() => null) : Promise.resolve(null),
      market.tokenIdNo ? getOrderBook(market.tokenIdNo).catch(() => null) : Promise.resolve(null),
    ]);

    const yesBid = summarizeBookLevels(yesBook?.bids || [], 'bid');
    const yesAsk = summarizeBookLevels(yesBook?.asks || [], 'ask');
    const noBid = summarizeBookLevels(noBook?.bids || [], 'bid');
    const noAsk = summarizeBookLevels(noBook?.asks || [], 'ask');
    if (yesBook) {
      const labPayload = buildLabParamsPayload(market, yesBook, botState.cash);
      if (labPayload) broadcast(labPayload);
    }
    broadcast({
      source: 'polymarket',
      type: 'orderbook',
      market: {
        conditionId: market.conditionId,
        question: market.question,
        windowMinutes: market.windowMinutes,
        endTime: market.endTime,
        selectedMode: selectedPolyMode,
      },
      yes: { bid: yesBid, ask: yesAsk },
      no: { bid: noBid, ask: noAsk },
      via: 'clob_book_poll',
      timestamp: Date.now(),
    });
    polymarketConnected = true;
    polyStreamStats.orderbook += 1;
    polyStreamStats.lastAt = Date.now();
    recordStreamLatency('poly_orderbook_poll', {
      sourceTs: pollStart,
      receivedTs: Date.now(),
      meta: { conditionId: market.conditionId?.slice(0, 12) },
    });
  } catch (e) {
    broadcast({
      source: 'polymarket',
      type: 'error',
      message: `Orderbook fetch failed: ${e.message}`,
      timestamp: Date.now(),
    });
  }
}

function restartOrderbookPolling() {
  if (orderbookPollingTimer) clearInterval(orderbookPollingTimer);
  orderbookPollingTimer = setInterval(() => {
    publishOrderbookSnapshot().catch(() => {});
  }, ORDERBOOK_POLL_MS);
}

function syncSessionFromProfile(profile = botProfile) {
  selectedBotMarketWindow = profile.marketWindow;
  botRunLimit = { ...profile.runLimit };
  selectedStrategy = profile.strategyId;
}

function botProfileSnapshot() {
  return {
    strategyId: selectedStrategy,
    marketWindow: selectedBotMarketWindow,
    runLimit: { ...botRunLimit },
    stopLossPct: botProfile.stopLossPct,
    stopLossPrice: botProfile.stopLossPrice,
    stopThreshold: botProfile.stopThreshold,
    entryMinSeconds: botProfile.entryMinSeconds,
    entryMaxSeconds: botProfile.entryMaxSeconds,
    entryMinPrice: botProfile.entryMinPrice,
    entryMaxPrice: botProfile.entryMaxPrice,
    maxTradesPerMarket: botProfile.maxTradesPerMarket,
    updatedAt: botProfile.updatedAt,
  };
}

function botSessionSnapshot() {
  return botProfileSnapshot();
}

function applyBotProfile(body = {}, { persist = true } = {}) {
  const partial = { ...body };
  if (body.profile && typeof body.profile === 'object') {
    Object.assign(partial, body.profile);
  }
  const merged = normalizeBotProfile(
    {
      ...botProfileSnapshot(),
      ...partial,
      marketWindow: partial.marketWindow ?? selectedBotMarketWindow,
      runLimit: partial.runLimit ?? botRunLimit,
      strategyId: partial.strategyId ?? selectedStrategy,
    },
    botProfile
  );
  botProfile = persist ? saveBotProfile(merged) : merged;
  syncSessionFromProfile(botProfile);
  return botProfile;
}

/** @deprecated use applyBotProfile */
function applyBotSessionConfig(body = {}) {
  applyBotProfile(body);
}

function spawnBotEnv(profileId = activeProfileId) {
  const profile = getBotProfileById(profileId) || getBotProfileById('default');
  const botNatsFeeds = process.env.BOT_USE_NATS_FEEDS === 'true' || USE_NATS_FEEDS;
  const profileEnv = profile ? profileToSpawnEnv(profile, process.env) : {
    ...profileToEnv(botProfileSnapshot()),
    SIZING_MODE: resolveSizingConfig(getActivePreset()).sizingMode,
  };
  return {
    ...process.env,
    ...profileEnv,
    PAPER_TRADE: 'true',
    ENABLE_DASHBOARD_FEED: 'true',
    DASHBOARD_PORT: String(PORT),
    USE_NATS: USE_NATS ? 'true' : 'false',
    USE_NATS_FEEDS: USE_NATS_FEEDS ? 'true' : 'false',
    NATS_URL: process.env.NATS_URL || 'nats://127.0.0.1:4222',
    BOT_USE_NATS_FEEDS: botNatsFeeds ? 'true' : 'false',
  };
}

function startBotProcess(profileId = activeProfileId) {
  if (botProcess && !botProcess.killed && botState.running) {
    return { ok: false, statusCode: 409, body: { error: 'Bot already running', bot: botState } };
  }
  if (botStopPromise) {
    return { ok: false, statusCode: 409, body: { error: 'Bot is still stopping', bot: botState } };
  }
  const profile = getBotProfileById(profileId);
  if (profile) applyNamedProfileToSession(profile);
  const spawnProfileId = profile?.id || profileId || activeProfileId || 'default';
  const child = spawn(process.execPath, ['bot.js'], {
    cwd: ROOT_DIR,
    env: spawnBotEnv(spawnProfileId),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  botProcess = child;
  botState.running = true;
  botState.pid = child.pid || null;
  botState.mode = 'paper';
  botState.profileId = spawnProfileId;
  botState.startedAt = Date.now();
  botState.stoppedAt = null;
  botState.lastExitCode = null;
  resetPortfolioSession(spawnProfileId);
  setupBotProcessHandlers(child);
  const session = botSessionSnapshot();
  const profileName = getBotProfileById(spawnProfileId)?.name || spawnProfileId;
  broadcast(makeBotLogLine(
    `Bot started (pid=${botState.pid || 'n/a'}) · profile=${profileName} · markets=${session.marketWindow} · ${session.runLimit.mode === 'trades' ? `limit ${session.runLimit.tradeCount} trades` : session.runLimit.mode === 'end_of_day' ? 'until EOD' : 'no limit'}`,
    'info'
  ));
  broadcastPortfolio();
  sendStatus();
  return { ok: true, statusCode: 200, body: { bot: botState } };
}

function stopBotProcess() {
  if (botStopPromise) return botStopPromise;
  if (!botProcess || botProcess.killed || !botState.running) {
    return Promise.resolve({ ok: false, statusCode: 409, body: { error: 'Bot is not running', bot: botState } });
  }
  const child = botProcess;
  botStopPromise = new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const onExit = () => {
      child.off('exit', onExit);
      done({ ok: true, statusCode: 200, body: { bot: botState } });
    };
    child.on('exit', onExit);
    try {
      child.kill('SIGTERM');
    } catch (_) {
      child.off('exit', onExit);
      done({ ok: false, statusCode: 500, body: { error: 'Failed to signal bot', bot: botState } });
      return;
    }
    setTimeout(() => {
      if (!botState.running) {
        child.off('exit', onExit);
        done({ ok: true, statusCode: 200, body: { bot: botState } });
        return;
      }
      try { child.kill('SIGKILL'); } catch (_) {}
      child.off('exit', onExit);
      done({ ok: true, statusCode: 200, body: { bot: botState } });
    }, BOT_STOP_TIMEOUT_MS);
  });
  return botStopPromise.finally(() => {
    botStopPromise = null;
  });
}

async function maybeRollPrimaryMarket() {
  if (USE_NATS_FEEDS) return false;
  const previousId = selectedPrimaryMarketId;
  const current = lastMarkets.find((m) => m.conditionId === previousId) || getPrimaryMarket();
  if (!primaryNeedsRoll(current)) return false;

  await subscribePolymarketMarkets();
  if (!selectedPrimaryMarketId || selectedPrimaryMarketId === previousId) return false;

  const next = getPrimaryMarket();
  debugPoly('rolled primary market', previousId?.slice(0, 12), '→', selectedPrimaryMarketId.slice(0, 12));
  broadcast({
    source: 'polymarket',
    type: 'market_rolled',
    previousMarketId: previousId,
    conditionId: selectedPrimaryMarketId,
    selectedMode: selectedPolyMode,
    market: next ? marketWireFields(next) : undefined,
    timestamp: Date.now(),
  });
  return true;
}

function subscriptionStale(cycle) {
  return cycle !== polySubscriptionCycle;
}

async function subscribePolymarketMarkets() {
  const cycle = ++polySubscriptionCycle;
  closePolySubscriptions();
  polymarketConnected = false;

  let markets;
  try {
    markets = await getActiveBTCShortMarkets(modeToWindows(selectedPolyMode));
    if (subscriptionStale(cycle)) return;
    lastMarkets = filterAndRankMarkets(markets, selectedPolyMode);
  } catch (e) {
    if (subscriptionStale(cycle)) return;
    broadcast({
      source: 'polymarket',
      type: 'error',
      message: e.message,
      timestamp: Date.now(),
    });
    sendStatus();
    return;
  }

  if (!lastMarkets.length) {
    if (subscriptionStale(cycle)) return;
    selectedPrimaryMarketId = null;
    broadcast({
      source: 'polymarket',
      type: 'markets',
      markets: [],
      selectedMode: selectedPolyMode,
      message: 'No active BTC 5m/15m/1d markets',
      timestamp: Date.now(),
    });
    sendStatus();
    return;
  }

  lastMarkets = await enrichMarketsWithBeat(lastMarkets);
  if (subscriptionStale(cycle)) return;

  const primary = syncPrimaryMarketId();
  if (!primary) {
    if (subscriptionStale(cycle)) return;
    selectedPrimaryMarketId = null;
    sendStatus();
    return;
  }

  broadcast({
    source: 'polymarket',
    type: 'markets',
    selectedMode: selectedPolyMode,
    selectedMarketId: selectedPrimaryMarketId,
    markets: lastMarkets.map((m) => marketWireFields(m)),
    timestamp: Date.now(),
  });

  if (subscriptionStale(cycle)) return;
  broadcastMarketDetails(primary.conditionId).catch(() => {});
  const emitPrices = (market, yesPrice, noPrice, side, via = 'ws', timing = null) => {
    if (cycle !== polySubscriptionCycle) return;
    if (market.conditionId !== selectedPrimaryMarketId) return;
    const { yes, no } = pairYesNoPrices(yesPrice, noPrice);
    if (yes == null && no == null) return;
    if (via === 'ws') {
      const now = Date.now();
      if (now - lastPolyWsEmitAt < POLY_WS_THROTTLE_MS) return;
      lastPolyWsEmitAt = now;
    }
    polymarketConnected = true;
    lastPolyVia = via;
    if (via === 'ws') polyStreamStats.ws += 1;
    else if (via === 'midpoint' || via === 'midpoint_poll') polyStreamStats.midpoint += 1;
    polyStreamStats.lastAt = Date.now();
    const receivedAt = Date.now();
    if (via === 'ws' && timing?.sourceTs) {
      recordStreamLatency('poly_ws_price', {
        sourceTs: timing.sourceTs,
        receivedTs: timing.receivedAt || receivedAt,
        meta: { side, eventType: timing.eventType },
      });
    } else if (via === 'midpoint' || via === 'midpoint_poll') {
      // REST RTT recorded in getMidpoint() when applicable.
    }
    debugPoly(via, { yes, no, side, q: market.question?.slice(0, 40) });
    rememberMarketYesPrice(market.conditionId, yes);
    if (revalueOpenPositionsFromCache()) {
      broadcastPortfolio();
    }
    broadcast({
      source: 'polymarket',
      type: 'price',
      side,
      via,
      yesPrice: yes,
      noPrice: no,
      latencyMs: timing?.sourceTs ? receivedAt - timing.sourceTs : undefined,
      market: {
        ...marketWireFields(market),
        selectedMode: selectedPolyMode,
        isPrimary: true,
      },
      timestamp: Date.now(),
    });
  };

  const seedMidpoints = async (market) => {
    try {
      const [yesPrice, noPrice] = await Promise.all([
        market.tokenIdYes ? getMidpoint(market.tokenIdYes).catch(() => null) : null,
        market.tokenIdNo ? getMidpoint(market.tokenIdNo).catch(() => null) : null,
      ]);
      emitPrices(market, yesPrice, noPrice, 'snapshot', 'midpoint');
    } catch (_) {}
  };

  await seedMidpoints(primary);
  if (subscriptionStale(cycle)) return;

  const assets = [primary.tokenIdYes, primary.tokenIdNo].filter(Boolean);
  if (assets.length) {
    const handle = subscribeClobAssets(
      assets,
      (assetId, price, eventType, timing) => {
        if (assetId === primary.tokenIdYes) emitPrices(primary, price, null, 'yes', 'ws', timing);
        else if (assetId === primary.tokenIdNo) emitPrices(primary, null, price, 'no', 'ws', timing);
      },
      (err) => {
        const msg = String(err?.message || err);
        debugPoly('ws error', msg);
        broadcast({
          source: 'polymarket',
          type: 'error',
          message: msg,
          timestamp: Date.now(),
        });
      },
      {
        tokenIdYes: primary.tokenIdYes,
        tokenIdNo: primary.tokenIdNo,
        onTrade: (trade) => emitPolymarketTrade(primary, trade, 'clob_ws'),
      }
    );
    polySubscriptions.set(`${primary.conditionId}:clob`, handle);
    debugPoly('subscribed primary', primary.question?.slice(0, 50), assets.length, 'tokens');
  }

  sendStatus();
}

function startMidpointFallback() {
  setInterval(async () => {
    if (!polySubscriptions.size) return;
    if (await maybeRollPrimaryMarket()) return;
    lastMarkets = filterAndRankMarkets(lastMarkets, selectedPolyMode);
    const market = getPrimaryMarket();
    if (!market) return;
    try {
      const [yesPrice, noPrice] = await Promise.all([
        market.tokenIdYes ? getMidpoint(market.tokenIdYes).catch(() => null) : null,
        market.tokenIdNo ? getMidpoint(market.tokenIdNo).catch(() => null) : null,
      ]);
      const { yes, no } = pairYesNoPrices(yesPrice, noPrice);
      if (yes == null && no == null) return;
      polymarketConnected = true;
      lastPolyVia = 'midpoint_poll';
      polyStreamStats.midpoint += 1;
      polyStreamStats.lastAt = Date.now();
      broadcast({
        source: 'polymarket',
        type: 'price',
        yesPrice: yes,
        noPrice: no,
        side: 'snapshot',
        market: {
          ...marketWireFields(market),
          selectedMode: selectedPolyMode,
          isPrimary: true,
        },
        timestamp: Date.now(),
        via: 'midpoint_poll',
      });
      rememberMarketYesPrice(market.conditionId, yes);
      if (revalueOpenPositionsFromCache()) {
        broadcastPortfolio();
      }
    } catch (_) {}
    sendStatus();
  }, MIDPOINT_FALLBACK_MS);
}

function startChainlinkPoll() {
  if (chainlinkPollTimer) return;
  const rpc = process.env.POLYGON_RPC;
  if (!rpc) return;
  let provider;
  try {
    const { ethers } = require('ethers');
    provider = new ethers.JsonRpcProvider(rpc);
  } catch (_) {
    return;
  }
  pollChainlink(provider).catch(() => {});
  chainlinkPollTimer = setInterval(() => {
    pollChainlink(provider).catch(() => {});
  }, 30_000);
}

function startBinanceFeed() {
  const url = process.env.BINANCE_WS_URL || 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade';
  connectBinanceFeed((price, timing) => {
    binanceConnected = true;
    const chainlink = getChainlinkState();
    const receivedAt = timing?.receivedAt || Date.now();
    broadcast({
      source: 'binance',
      type: 'price',
      price,
      chainlinkPrice: Number.isFinite(chainlink.price) ? chainlink.price : undefined,
      chainlinkAgeMs: chainlink.updatedAt ? receivedAt - chainlink.updatedAt : undefined,
      symbol: 'BTCUSDT',
      latencyMs: timing?.latencyMs,
      timestamp: receivedAt,
    });
  });
  startChainlinkPoll();
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/bot-event') {
      try {
        const body = await readJsonBody(req);
        ingestBotEvent(body);
        res.writeHead(204);
        res.end();
      } catch (e) {
        res.writeHead(400);
        res.end('Bad JSON');
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/api/latency') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(getSnapshot()));
      return;
    }
    if (req.method === 'GET' && (req.url === '/api/events/stream' || req.url === '/stream')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      res.write(`data: ${JSON.stringify({ source: 'latency', type: 'snapshot', ...getSnapshot() })}\n\n`);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/latency/trade-poll') {
      try {
        const body = await readJsonBody(req);
        if (body?.tradeId && body?.poll) ingestTradePoll(body.tradeId, body.poll);
        res.writeHead(204);
        res.end();
      } catch (_) {
        res.writeHead(400);
        res.end('Bad JSON');
      }
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/portfolio')) {
      const urlQuery = req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]) : null;
      const profileQuery = urlQuery?.get('profileId');
      if (profileQuery && profileQuery !== activeProfileId && !botState.running) {
        loadPortfolioForProfile(profileQuery);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(portfolioSnapshot()));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/portfolio/cash') {
      try {
        const body = await readJsonBody(req);
        const parsed = parseCashAdjustmentRequest(body);
        if (parsed.error) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: parsed.error }));
          return;
        }
        const result = applyPortfolioCashAdjustment(parsed);
        res.writeHead(result.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: result.ok,
          error: result.error || null,
          portfolio: result.snapshot || portfolioSnapshot(),
          netCashDelta: result.netCashDelta ?? portfolioState.netCashDelta,
          botRunning: botState.running,
          botSyncNote: botState.running
            ? 'Running bot picks up adjustments on its next cycle via data/cash-adjustments.json'
            : null,
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/api/portfolio/close-resolved') {
      try {
        const resolvedMap = new Map();
        const recent = await getRecentResolvedMarkets(60).catch(() => []);
        for (const m of recent) {
          if (m.outcome === 'Yes' || m.outcome === 'No') {
            resolvedMap.set(m.conditionId, m.outcome);
          }
        }
        const result = await closeResolvedPositions(portfolioState.openPositions, {
          resolvedMap,
          cash: portfolioState.cash,
          realizedPnlTotal: portfolioState.realizedPnlTotal,
        });
        const closedSummaries = [];
        for (const { exitEvent } of result.closed) {
          applyPortfolioEvent({
            ...exitEvent,
            type: 'exit',
            mode: portfolioState.mode,
            timestamp: exitEvent.exitTime || Date.now(),
          });
          closedSummaries.push({
            tradeId: exitEvent.tradeId,
            marketId: exitEvent.marketId,
            question: exitEvent.question,
            pnl: exitEvent.pnl,
            exitPrice: exitEvent.exitPrice,
            resolvedOutcome: exitEvent.resolvedOutcome,
          });
        }
        portfolioState.openPositions = result.remaining;
        portfolioState.cash = result.cash;
        portfolioState.realizedPnlTotal = result.realizedPnlTotal;
        portfolioState.updatedAt = Date.now();
        botState.cash = result.cash;
        const snapshot = broadcastPortfolio();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          closedCount: result.closed.length,
          closed: closedSummaries,
          portfolio: snapshot,
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/api/bot/status') {
      const activePreset = getActivePreset();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        bot: { ...botState, strategyId: selectedStrategy, ...botSessionSnapshot() },
        sizing: resolveSizingConfig(activePreset),
        selectedPolyMode,
        botSession: botSessionSnapshot(),
        strategies: strategyOptions,
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/bot/config') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        botSession: botSessionSnapshot(),
        profile: botProfileSnapshot(),
        running: botState.running,
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/bot/config') {
      try {
        const body = await readJsonBody(req);
        applyBotProfile(body);
        sendStatus();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          botSession: botSessionSnapshot(),
          profile: botProfileSnapshot(),
          running: botState.running,
        }));
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Bad JSON' }));
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/api/bot/profiles') {
      const profiles = listBotProfiles();
      const active = getBotProfileById(activeProfileId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        profiles,
        activeProfileId,
        activeProfile: active,
        sizingPreview: active ? previewBetForProfile(active, portfolioState.cash) : null,
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/bot/profiles') {
      try {
        const body = await readJsonBody(req);
        if (body.action === 'delete' && body.id) {
          if (listBotProfiles().length <= 1) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Cannot delete the last profile' }));
            return;
          }
          const profiles = deleteNamedProfile(body.id);
          if (activeProfileId === body.id) {
            loadPortfolioForProfile(profiles[0]?.id || 'default');
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ profiles, activeProfileId, deleted: body.id }));
          return;
        }
        if (body.action === 'duplicate' && body.id) {
          const copy = duplicateNamedProfile(body.id, body.name);
          if (!copy) {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Profile not found' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ profile: copy, profiles: listBotProfiles() }));
          return;
        }
        const merged = normalizeNamedProfile({
          ...getBotProfileById(body.id || activeProfileId),
          ...body,
          id: body.id || body.name,
          name: body.name || body.id,
        });
        const saved = saveNamedProfile(merged);
        if (body.select || body.apply) {
          applyNamedProfileToSession(saved);
          sendStatus();
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          profile: saved,
          profiles: listBotProfiles(),
          activeProfileId,
          sizingPreview: previewBetForProfile(saved, portfolioState.cash),
        }));
      } catch (e) {
        const status = e instanceof SyntaxError ? 400 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message || 'Request failed' }));
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/api/bot/instances') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        instances: botState.running
          ? [{
            pid: botState.pid,
            profileId: botState.profileId,
            startedAt: botState.startedAt,
            mode: botState.mode,
          }]
          : [],
        running: botState.running,
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/bot/profile') {
      const activePreset = getActivePreset();
      const profile = getBotProfileById(activeProfileId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        profile: botProfileSnapshot(),
        namedProfile: profile,
        activeProfileId,
        botSession: botSessionSnapshot(),
        strategies: strategyOptions,
        activeLabPreset: { id: activePreset.id, name: activePreset.name },
        sizing: resolveSizingConfig(activePreset),
        sizingPreview: profile
          ? previewBetForProfile(profile, portfolioState.cash)
          : previewBetLabel(portfolioState.cash, resolveSizingConfig(activePreset)),
        running: botState.running,
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/bot/profile') {
      try {
        const body = await readJsonBody(req);
        applyBotProfile(body);
        if (body.sizingMode || body.betPercent != null || body.fixedBetUsd != null) {
          const active = getActivePreset();
          setActivePreset({ ...active, ...pickSizingBody(body) });
        }
        if (activeProfileId) {
          const current = getBotProfileById(activeProfileId);
          if (current) {
            saveNamedProfile(normalizeNamedProfile({ ...current, ...body, id: activeProfileId }));
          }
        }
        if (body.applyLabPreset) {
          const active = getActivePreset();
          setActivePreset(active);
        }
        sendStatus();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          profile: botProfileSnapshot(),
          botSession: botSessionSnapshot(),
          activeProfileId,
          selectedStrategy,
          running: botState.running,
        }));
      } catch (e) {
        const status = e instanceof SyntaxError ? 400 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          error: e instanceof SyntaxError ? 'Bad JSON' : (e.message || 'Request failed'),
        }));
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/api/bot/strategies') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ selectedStrategy, strategies: strategyOptions }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/bot/strategy') {
      try {
        const body = await readJsonBody(req);
        applyBotProfile({ strategyId: body?.strategyId });
        await publishBotControl('strategy', { strategyId: selectedStrategy });
        sendStatus();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ selectedStrategy, strategies: strategyOptions }));
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Bad JSON' }));
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/api/bot/start') {
      let startBody = {};
      try {
        startBody = await readJsonBody(req);
      } catch (_) {
        startBody = {};
      }
      applyBotSessionConfig(startBody);
      const startProfileId = startBody.profileId || activeProfileId;
      const result = await enqueueBotLifecycle(async () => {
        if (botStopPromise) await botStopPromise;
        await publishBotControl('start', {
          strategyId: selectedStrategy,
          mode: selectedPolyMode,
          profileId: startProfileId,
          ...botSessionSnapshot(),
        });
        return startBotProcess(startProfileId);
      });
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.body));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/bot/stop') {
      const result = await enqueueBotLifecycle(async () => {
        await publishBotControl('stop');
        return stopBotProcess();
      });
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.body));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/polymarket/mode') {
      try {
        const body = await readJsonBody(req);
        const nextMode = normalizePolyMode(body?.mode);
        selectedPolyMode = nextMode;
        selectedPrimaryMarketId = null;
        if (USE_NATS_FEEDS) {
          await publishBotControl('window', { mode: selectedPolyMode });
        }
        if (!USE_NATS_FEEDS) {
          await subscribePolymarketMarkets();
        } else {
          sendStatus();
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ selectedPolyMode, selectedMarketId: selectedPrimaryMarketId }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Bad JSON' }));
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/api/polymarket/mode') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ selectedPolyMode, selectedMarketId: selectedPrimaryMarketId }));
      return;
    }

    const urlPath = req.url.split('?')[0];
    const urlQuery = req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]) : null;

    if (req.method === 'GET' && urlPath === '/api/markets') {
      const windowKey = windowQueryToKey(urlQuery?.get('window'));
      if (!windowKey) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'window query required (5m, 15m, or 1d)' }));
        return;
      }
      try {
        const markets = await listLiveBTCMarketsForWindow(windowKey);
        const enriched = await enrichMarketsWithBeat(markets);
        const windowMinutes = modeToWindows(windowKey)[0];
        const preferred = getPrimaryMarket()?.windowMinutes === windowMinutes
          ? selectedPrimaryMarketId
          : null;
        const primary = pickPrimaryLiveMarket(enriched, [windowMinutes], preferred);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          window: windowKey,
          count: enriched.length,
          selectedMarketId: primary?.conditionId || null,
          markets: enriched.map((m) => marketWireFields(m)),
          timestamp: Date.now(),
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    const marketDetailMatch = urlPath.match(/^\/api\/markets\/(0x[a-fA-F0-9]+)$/);
    if (req.method === 'GET' && marketDetailMatch) {
      try {
        const payload = await buildMarketDetailPayload(marketDetailMatch[1]);
        if (!payload) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Market not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/markets/select') {
      try {
        const body = await readJsonBody(req);
        const result = await setPrimaryMarket(body?.conditionId, { syncMode: body?.syncMode !== false });
        if (!result.ok) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message || 'Bad JSON' }));
      }
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/markets/selected') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        selectedMarketId: selectedPrimaryMarketId,
        selectedPolyMode,
        market: getPrimaryMarket() ? marketWireFields(getPrimaryMarket()) : null,
        details: lastMarketDetails,
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/lab/params') {
      const snapshot = getLastLabParams();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snapshot || { params: null, message: 'No params computed yet' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/lab/presets') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        presets: listPresets(),
        active: getActivePreset(),
        defaults: defaultPresetFields(),
        sizingDefaults: sizingSnapshot(),
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/bot/sizing') {
      const active = getActivePreset();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        sizing: sizingSnapshot(active),
        active: {
          id: active.id,
          name: active.name,
          sizingMode: active.sizingMode,
          fixedBetUsd: active.fixedBetUsd,
          betPercent: active.betPercent,
          kellyFractionCap: active.kellyFractionCap,
        },
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/lab/preset/active') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ active: getActivePreset() }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/lab/preset') {
      try {
        const body = await readJsonBody(req);
        const saved = savePreset(body);
        let active = getActivePreset();
        if (body.apply) {
          active = setActivePreset(saved);
          if (body.botProfile && typeof body.botProfile === 'object') {
            applyBotProfile(body.botProfile);
          }
          broadcast({
            source: 'lab',
            type: 'preset_applied',
            timestamp: Date.now(),
            preset: active,
            sizing: resolveSizingConfig(active),
            profile: botProfileSnapshot(),
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ preset: saved, active, applied: Boolean(body.apply) }));
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Bad JSON' }));
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/api/lab/preset/apply') {
      try {
        const body = await readJsonBody(req);
        let preset = body;
        if (body?.id) {
          preset = getPresetById(body.id)
            || (getActivePreset().id === body.id ? getActivePreset() : null);
        }
        if (!preset) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Preset not found' }));
          return;
        }
        const active = setActivePreset(preset);
        if (body.botProfile && typeof body.botProfile === 'object') {
          applyBotProfile(body.botProfile);
        }
        broadcast({
          source: 'lab',
          type: 'preset_applied',
          timestamp: Date.now(),
          preset: active,
          sizing: resolveSizingConfig(active),
          profile: botProfileSnapshot(),
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          active,
          sizing: resolveSizingConfig(active),
          profile: botProfileSnapshot(),
        }));
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Bad JSON' }));
      }
      return;
    }
    serveStatic(req, res);
  });
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => {
      clients.delete(ws);
      sendStatus();
    });
    ws.send(JSON.stringify({
      source: 'system',
      type: 'hello',
      timestamp: Date.now(),
      port: PORT,
      selectedPolyMode,
      selectedMarketId: selectedPrimaryMarketId,
      strategies: strategyOptions,
      selectedStrategy,
      bot: {
        running: botState.running,
        pid: botState.pid,
        cash: botState.cash,
        mode: botState.mode,
        strategyId: selectedStrategy,
      },
      portfolio: portfolioSnapshot(),
    }));
    sendStatus();
  });

  hub.on('dashboard', (event) => {
    if (event?.source === 'bot') ingestBotEvent(event);
    else if (event?.source === 'lab' && event?.type === 'params') broadcast(event);
    else broadcast(event);
  });

  server.listen(PORT, () => {
    console.log(`[Dashboard] http://localhost:${PORT}/live`);
    console.log(`[Dashboard] pages: /live /orderbook /bot /portfolio /markets /backtest /lab /latency /docs`);
    console.log(`[Dashboard] WebSocket ws://localhost:${PORT}/ws`);
    console.log(`[Dashboard] SSE       http://localhost:${PORT}/api/events/stream`);
  });

  onSnapshot((snap) => {
    broadcast({ source: 'latency', type: 'snapshot', ...snap });
  });

  setInterval(() => {
    broadcast({ source: 'latency', type: 'snapshot', ...getSnapshot() });
  }, 3000);

  return server;
}

function registerShutdown() {
  async function shutdown() {
    await stopBotProcess().catch(() => {});
    const bridge = getNatsBridge();
    if (bridge) await bridge.close().catch(() => {});
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function startNatsBridge() {
  if (!USE_NATS || natsConnectFailed) return;
  const bridge = getNatsBridge();
  if (!bridge) return;
  if (natsBridgeInit) return natsBridgeInit;

  natsBridgeInit = (async () => {
    try {
      await Promise.race([
        bridge.connect(),
        new Promise((_, reject) => {
          setTimeout(
            () => reject(new Error(`NATS connect timeout (${NATS_CONNECT_TIMEOUT_MS}ms)`)),
            NATS_CONNECT_TIMEOUT_MS
          );
        }),
      ]);
      natsConnected = true;
      console.log(`[Dashboard] NATS bridge ${process.env.NATS_URL || 'nats://127.0.0.1:4222'}`);
      await bridge.subscribe('feeds.>', (msg, subject) => bridgeNatsMessage(subject, msg));
      await bridge.subscribe(SUBJECTS.BOT_EVENTS, (msg, subject) => bridgeNatsMessage(subject, msg));
      await bridge.subscribe(SUBJECTS.BOT_STATUS, (msg, subject) => bridgeNatsMessage(subject, msg));
      bridge.onStatus((s) => {
        natsConnected = s.connected;
        if (s.lastEvent === 'disconnect') {
          binanceConnected = USE_NATS_FEEDS ? false : binanceConnected;
          polymarketConnected = USE_NATS_FEEDS ? false : polymarketConnected;
        }
        sendStatus();
      });
    } catch (e) {
      natsConnectFailed = true;
      natsConnected = false;
      console.warn('[Dashboard] NATS unavailable:', e.message);
      if (USE_NATS_FEEDS || !directFeedsStarted) {
        startDirectFeeds().catch((err) => console.warn('[Dashboard] direct feed fallback failed:', err.message));
      }
    } finally {
      natsBridgeInit = null;
    }
  })();

  return natsBridgeInit;
}

async function startDirectFeeds() {
  if (directFeedsStarted) return;
  directFeedsStarted = true;
  console.log('[Dashboard] direct feed ingest (CLOB WS + midpoint poll)');
  startBinanceFeed();
  await subscribePolymarketMarkets();
  await publishOrderbookSnapshot();
  setInterval(subscribePolymarketMarkets, MARKET_REFRESH_MS);
  setInterval(() => {
    maybeRollPrimaryMarket().catch(() => {});
  }, MARKET_ROLL_CHECK_MS);
  startMidpointFallback();
  restartOrderbookPolling();
}

async function main() {
  registerShutdown();
  startHttpServer();
  await startNatsBridge();

  if (!USE_NATS_FEEDS) {
    await startDirectFeeds();
  } else {
    console.log('[Dashboard] feed ingest via NATS (feeds.>) — will fall back to direct if idle');
    setTimeout(async () => {
      if (!polymarketConnected && !directFeedsStarted) {
        console.warn(`[Dashboard] no Polymarket NATS data after ${NATS_FEED_FALLBACK_MS}ms — starting direct feeds`);
        await startDirectFeeds();
        sendStatus();
      }
    }, NATS_FEED_FALLBACK_MS);
  }

  setInterval(sendStatus, 10_000);
  if (DEBUG_POLY_STREAM) {
    setInterval(() => {
      console.log('[poly-stream] stats', JSON.stringify(polyStreamStats));
    }, 15_000);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[Dashboard] fatal:', e);
    process.exit(1);
  });
}

module.exports = { broadcast, main };
