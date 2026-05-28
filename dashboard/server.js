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
  subscribeClobAssets,
  pairYesNoPrices,
  getMidpoint,
  getOrderBook,
  parseWindowStartMs,
} = require('../api/polymarket_runtime');
const { hub } = require('./hub');
const { listStrategies, normalizeStrategyId } = require('../signals/strategies_runtime');
const { createNatsBridge } = require('../lib/natsBridge');
const { SUBJECTS } = require('../lib/nats/subjects');
const { toDashboardWire, botStatus, botControl, polymarketTrade } = require('../lib/nats/schemas');

const PORT = Number(process.env.DASHBOARD_PORT || 3847);
const USE_NATS = process.env.USE_NATS !== 'false' && process.env.NATS_URL !== 'disabled';
const USE_NATS_FEEDS = USE_NATS && process.env.USE_NATS_FEEDS === 'true';
const DEBUG_POLY_STREAM = process.env.DEBUG_POLY_STREAM === 'true';
const NATS_FEED_FALLBACK_MS = Number(process.env.NATS_FEED_FALLBACK_MS || 12_000);
const NATS_CONNECT_TIMEOUT_MS = Number(process.env.NATS_CONNECT_TIMEOUT_MS || 8_000);
const POLY_WS_THROTTLE_MS = Number(process.env.POLY_WS_THROTTLE_MS || 250);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MARKET_REFRESH_MS = 45_000;
const MIDPOINT_FALLBACK_MS = 5_000;
const ORDERBOOK_POLL_MS = 2_500;
const BOT_STOP_TIMEOUT_MS = 6_000;
const ROOT_DIR = path.join(__dirname, '..');

const clients = new Set();
const polySubscriptions = new Map(); // key: conditionId:yes|no

let binanceConnected = false;
let polymarketConnected = false;
let selectedPolyMode = String(process.env.DASHBOARD_POLY_MODE || process.env.MARKET_WINDOW || '15');
let lastMarkets = [];
let polySubscriptionCycle = 0;
let botProcess = null;
let botStopPromise = null;
let botLifecycle = Promise.resolve();
let selectedStrategy = normalizeStrategyId(process.env.BOT_STRATEGY || 'deterministic_yes_50');
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
let lastPolyWsEmitAt = 0;
/** @type {Map<string, { priceToBeat: number, windowStartTime: number, priceToBeatSource: string }>} */
const priceToBeatCache = new Map();
let chainlinkPollTimer = null;
const botState = {
  running: false,
  pid: null,
  mode: 'paper',
  bankroll: Number.parseFloat(process.env.STARTING_BANKROLL || '5'),
  startedAt: null,
  stoppedAt: null,
  lastExitCode: null,
  logs: [],
};

function normalizePolyMode(mode) {
  const v = String(mode || '').trim().toLowerCase();
  if (v === '5' || v === '5m') return '5m';
  if (v === '15' || v === '15m') return '15m';
  if (v === 'both' || v === 'all' || v === '5,15' || v === '15,5') return 'both';
  return '15m';
}

selectedPolyMode = normalizePolyMode(selectedPolyMode);

function modeToWindows(mode) {
  if (mode === '5m') return [5];
  if (mode === '15m') return [15];
  return [5, 15];
}

function broadcast(payload) {
  const raw = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
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
    clientCount: clients.size,
    bot: {
      running: botState.running,
      pid: botState.pid,
      mode: botState.mode,
      strategyId: selectedStrategy,
      bankroll: botState.bankroll,
      startedAt: botState.startedAt,
      stoppedAt: botState.stoppedAt,
      lastExitCode: botState.lastExitCode,
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
        bankroll: botState.bankroll,
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

  if (wire.source === 'bot' && wire.type === 'state') {
    if (Number.isFinite(wire.bankroll)) botState.bankroll = wire.bankroll;
    if (typeof wire.running === 'boolean') botState.running = wire.running;
  }
  if (wire.source === 'bot' && Number.isFinite(wire.bankrollAfter)) {
    botState.bankroll = wire.bankrollAfter;
  }
  if (wire.source === 'bot' && wire.type === 'log') {
    botState.logs.unshift(wire);
    if (botState.logs.length > 250) botState.logs.pop();
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
  '/markets': '/markets.html',
  '/backtest': '/backtest.html',
  '/docs': '/docs/index.html',
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
    windowStartTime: m.windowStartTime ?? parseWindowStartMs(m) ?? undefined,
    priceToBeat: m.priceToBeat,
    priceToBeatSource: m.priceToBeatSource,
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
  const allowed = modeToWindows(mode);
  const now = Date.now();
  const byId = new Map();
  for (const m of markets || []) {
    if (!m?.conditionId || !Number.isFinite(m?.endTime)) continue;
    if (!allowed.includes(m.windowMinutes)) continue;
    if (m.endTime <= now) continue;
    byId.set(m.conditionId, m);
  }
  return [...byId.values()].sort((a, b) => a.endTime - b.endTime);
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
    const money = line.match(/bankroll=\$([0-9]+(?:\.[0-9]+)?)/i)
      || line.match(/bankroll:\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
    if (money) {
      const val = Number.parseFloat(money[1]);
      if (Number.isFinite(val)) {
        botState.bankroll = val;
        broadcast({
          source: 'bot',
          type: 'state',
          timestamp: Date.now(),
          bankroll: botState.bankroll,
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
    broadcast(makeBotLogLine(`Bot exited (code=${code ?? 'null'}, signal=${signal || 'none'})`, 'warn'));
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
  const market = lastMarkets[0];
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

function spawnBotEnv() {
  const botNatsFeeds = process.env.BOT_USE_NATS_FEEDS === 'true' || USE_NATS_FEEDS;
  return {
    ...process.env,
    PAPER_TRADE: 'true',
    ENABLE_DASHBOARD_FEED: 'true',
    USE_NATS: USE_NATS ? 'true' : 'false',
    USE_NATS_FEEDS: USE_NATS_FEEDS ? 'true' : 'false',
    NATS_URL: process.env.NATS_URL || 'nats://127.0.0.1:4222',
    BOT_USE_NATS_FEEDS: botNatsFeeds ? 'true' : 'false',
    BOT_STRATEGY: selectedStrategy,
    MARKET_WINDOW: selectedPolyMode === 'both' ? 'both' : selectedPolyMode.replace('m', ''),
  };
}

function startBotProcess() {
  if (botProcess && !botProcess.killed && botState.running) {
    return { ok: false, statusCode: 409, body: { error: 'Bot already running', bot: botState } };
  }
  if (botStopPromise) {
    return { ok: false, statusCode: 409, body: { error: 'Bot is still stopping', bot: botState } };
  }
  const child = spawn(process.execPath, ['bot.js'], {
    cwd: ROOT_DIR,
    env: spawnBotEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  botProcess = child;
  botState.running = true;
  botState.pid = child.pid || null;
  botState.mode = 'paper';
  botState.startedAt = Date.now();
  botState.stoppedAt = null;
  botState.lastExitCode = null;
  setupBotProcessHandlers(child);
  broadcast(makeBotLogLine(`Bot started (pid=${botState.pid || 'n/a'})`, 'info'));
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

async function subscribePolymarketMarkets() {
  const cycle = ++polySubscriptionCycle;
  closePolySubscriptions();
  polymarketConnected = false;

  let markets;
  try {
    markets = await getActiveBTCShortMarkets(modeToWindows(selectedPolyMode));
    lastMarkets = filterAndRankMarkets(markets, selectedPolyMode);
  } catch (e) {
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
    broadcast({
      source: 'polymarket',
      type: 'markets',
      markets: [],
      selectedMode: selectedPolyMode,
      message: 'No active BTC 5m/15m markets',
      timestamp: Date.now(),
    });
    sendStatus();
    return;
  }

  lastMarkets = await enrichMarketsWithBeat(lastMarkets);

  broadcast({
    source: 'polymarket',
    type: 'markets',
    selectedMode: selectedPolyMode,
    markets: lastMarkets.map((m) => marketWireFields(m)),
    timestamp: Date.now(),
  });

  const primary = lastMarkets[0];
  const emitPrices = (market, yesPrice, noPrice, side, via = 'ws') => {
    if (cycle !== polySubscriptionCycle) return;
    if (market.conditionId !== primary.conditionId) return;
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
    debugPoly(via, { yes, no, side, q: market.question?.slice(0, 40) });
    broadcast({
      source: 'polymarket',
      type: 'price',
      side,
      via,
      yesPrice: yes,
      noPrice: no,
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

  const assets = [primary.tokenIdYes, primary.tokenIdNo].filter(Boolean);
  if (assets.length) {
    const handle = subscribeClobAssets(
      assets,
      (assetId, price) => {
        if (assetId === primary.tokenIdYes) emitPrices(primary, price, null, 'yes', 'ws');
        else if (assetId === primary.tokenIdNo) emitPrices(primary, null, price, 'no', 'ws');
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
    lastMarkets = filterAndRankMarkets(lastMarkets, selectedPolyMode);
    const market = lastMarkets[0];
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
  connectBinanceFeed((price) => {
    binanceConnected = true;
    const chainlink = getChainlinkState();
    broadcast({
      source: 'binance',
      type: 'price',
      price,
      chainlinkPrice: Number.isFinite(chainlink.price) ? chainlink.price : undefined,
      symbol: 'BTCUSDT',
      timestamp: Date.now(),
    });
  });
  startChainlinkPoll();
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/bot-event') {
      try {
        const body = await readJsonBody(req);
        if (Number.isFinite(body?.bankrollAfter)) {
          botState.bankroll = body.bankrollAfter;
        } else if (Number.isFinite(body?.bankrollBefore)) {
          botState.bankroll = body.bankrollBefore;
        }
        if (!USE_NATS) {
          const payload = { source: 'bot', timestamp: Date.now(), ...body };
          broadcast(payload);
          if (Number.isFinite(botState.bankroll)) {
            broadcast({
              source: 'bot',
              type: 'state',
              timestamp: Date.now(),
              bankroll: botState.bankroll,
              running: botState.running,
              mode: botState.mode,
              pid: botState.pid,
            });
          }
          sendStatus();
        }
        res.writeHead(204);
        res.end();
      } catch (e) {
        res.writeHead(400);
        res.end('Bad JSON');
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/api/bot/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ bot: { ...botState, strategyId: selectedStrategy }, selectedPolyMode, strategies: strategyOptions }));
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
        selectedStrategy = normalizeStrategyId(body?.strategyId);
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
      const result = await enqueueBotLifecycle(async () => {
        if (botStopPromise) await botStopPromise;
        await publishBotControl('start', { strategyId: selectedStrategy, mode: selectedPolyMode });
        return startBotProcess();
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
        if (nextMode !== selectedPolyMode) {
          selectedPolyMode = nextMode;
          await publishBotControl('window', { mode: selectedPolyMode });
          if (!USE_NATS_FEEDS) await subscribePolymarketMarkets();
        } else {
          sendStatus();
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ selectedPolyMode }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Bad JSON' }));
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/api/polymarket/mode') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ selectedPolyMode }));
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
      strategies: strategyOptions,
      selectedStrategy,
      bot: {
        running: botState.running,
        pid: botState.pid,
        bankroll: botState.bankroll,
        mode: botState.mode,
        strategyId: selectedStrategy,
      },
    }));
    sendStatus();
  });

  hub.on('dashboard', (event) => broadcast(event));

  server.listen(PORT, () => {
    console.log(`[Dashboard] http://localhost:${PORT}/live`);
    console.log(`[Dashboard] pages: /live /orderbook /bot /markets /backtest /docs`);
    console.log(`[Dashboard] WebSocket ws://localhost:${PORT}/ws`);
  });

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
