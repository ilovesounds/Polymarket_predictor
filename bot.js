/**
 * bot.js — Main live trading loop
 *
 * Prerequisites:
 *   npm install ethers node-fetch ws
 *   PRIVATE_KEY=0x... node bot.js
 *
 * Deploy on Dublin VPS for <1ms latency to Polymarket CLOB
 */

const { ethers }                       = require('ethers');
const {
  getActiveBTCShortMarkets,
  getRecentResolvedMarkets,
  getMidpoint,
  getLiquidityDepth,
  getAllowedWindows,
}                                       = require('./api/polymarket_runtime');
const {
  pollChainlink,
  connectBinanceFeed,
}                                       = require('./api/feeds_runtime');
const {
  HARD_FLOOR,
}                                       = require('./risk/manager_runtime');
const { emitTradeEvent }               = require('./logging/tradeEvents');
const {
  getStrategy,
  normalizeStrategyId,
}                                       = require('./signals/strategies_runtime');

const USE_NATS = process.env.USE_NATS !== 'false' && process.env.NATS_URL !== 'disabled';
const BOT_USE_NATS_FEEDS = USE_NATS && process.env.BOT_USE_NATS_FEEDS === 'true';

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const POLYGON_RPC    = process.env.POLYGON_RPC || 'https://polygon-rpc.com';
const PRIVATE_KEY    = process.env.PRIVATE_KEY;   // wallet with USDC on Polygon
const PAPER_TRADE    = true; // hard-enforced safety mode
const POLL_INTERVAL  = 30_000;  // 30 seconds between signal checks
const STOP_THRESHOLD = 0.45;
const ALLOWED_WINDOWS = getAllowedWindows();
const STRATEGY_ID = normalizeStrategyId(process.env.BOT_STRATEGY || 'deterministic_yes_50');
const ACTIVE_STRATEGY = getStrategy(STRATEGY_ID);

if (!PRIVATE_KEY) {
  console.warn('[Bot] No PRIVATE_KEY — running in paper trade mode');
}
if (process.env.PAPER_TRADE === 'false') {
  console.warn('[Safety] PAPER_TRADE=false ignored. Bot is hard-locked to PAPER mode.');
}

function fmtPrice(price) {
  if (!Number.isFinite(price)) return 'n/a';
  return price.toFixed(3);
}

function marketLabel(market) {
  return `${market.conditionId.slice(0, 8)}…`;
}

function isWithinTradingWindow(market, timeRemainingSec) {
  if (market.windowMinutes === 5) {
    return timeRemainingSec >= 30 && timeRemainingSec <= 270;
  }
  if (market.windowMinutes === 15) {
    return timeRemainingSec >= 60 && timeRemainingSec <= 840;
  }
  return false;
}

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────

let bankroll           = parseFloat(process.env.STARTING_BANKROLL || '5');
const btcPriceHistory  = [];   // last 20 Binance prices
const openPositions    = {};   // marketId → { signal, entryPrice, betSize, entryTime }
let recentResolutions  = [];   // last 10 resolved windows
let liveTradeSeq       = 0;
let natsBridge         = null;
let botShouldStop      = false;

// ─────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────

async function setup() {
  // #region agent log
  fetch('http://127.0.0.1:7837/ingest/d970f366-0641-4e67-8ab4-8e310df24ef3',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5a7232'},body:JSON.stringify({sessionId:'5a7232',runId:'pre-fix',hypothesisId:'H2',location:'bot.js:73',message:'setup start',data:{paperTrade:PAPER_TRADE,hasPrivateKey:Boolean(PRIVATE_KEY)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  console.log(`\n${'═'.repeat(50)}`);
  console.log('  POLYMARKET BTC 5M/15M BOT');
  console.log(`  Mode: ${PAPER_TRADE ? 'PAPER TRADE' : '⚡ LIVE'}`);
  console.log(`  Strategy: ${ACTIVE_STRATEGY.label} (${STRATEGY_ID})`);
  console.log(`  Market windows: ${ALLOWED_WINDOWS.map((w) => `${w}m`).join(', ')}`);
  console.log(`  Starting bankroll: $${bankroll}`);
  console.log(`${'═'.repeat(50)}\n`);

  if (BOT_USE_NATS_FEEDS) {
    const feedsOk = await startNatsFeeds();
    if (!feedsOk) startDirectBinanceFeed();
  } else {
    startDirectBinanceFeed();
  }

  if (USE_NATS) {
    await startNatsBot();
  }

  // Poll Chainlink every 30s when RPC is reachable
  try {
    const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
    await provider.getNetwork();
    setInterval(() => pollChainlink(provider), 30_000);
    await pollChainlink(provider);
  } catch (e) {
    // #region agent log
    fetch('http://127.0.0.1:7837/ingest/d970f366-0641-4e67-8ab4-8e310df24ef3',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5a7232'},body:JSON.stringify({sessionId:'5a7232',runId:'post-fix',hypothesisId:'H6',location:'bot.js:85',message:'chainlink rpc unavailable, polling disabled',data:{rpc:POLYGON_RPC,error:e.message},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    console.warn('[Setup] Chainlink polling disabled (RPC unavailable)');
  }

  // Load recent resolutions for EC6
  recentResolutions = await getRecentResolvedMarkets(10);

  console.log('[Setup] Binance feed connected');
  console.log('[Setup] Chainlink status initialized');
  console.log('[Setup] Ready to trade\n');
}

// ─────────────────────────────────────────────
// MAIN LOOP
// ─────────────────────────────────────────────

async function publishBotStatus(extra = {}) {
  if (!natsBridge) return;
  const { SUBJECTS } = require('./lib/nats/subjects');
  const { botStatus } = require('./lib/nats/schemas');
  await natsBridge.publish(
    SUBJECTS.BOT_STATUS,
    botStatus({
      running: !botShouldStop,
      mode: PAPER_TRADE ? 'paper' : 'live',
      strategyId: STRATEGY_ID,
      bankroll,
      ...extra,
    })
  ).catch(() => {});
}

function startDirectBinanceFeed() {
  connectBinanceFeed((price) => {
    btcPriceHistory.push(price);
    if (btcPriceHistory.length > 20) btcPriceHistory.shift();
  });
}

async function startNatsFeeds() {
  try {
    const { createNatsBridge } = require('./lib/natsBridge');
    const { SUBJECTS } = require('./lib/nats/subjects');
    natsBridge = natsBridge || createNatsBridge({ name: 'bot-feeds' });
    await natsBridge.connect();
    await natsBridge.subscribe(SUBJECTS.FEEDS_BINANCE_PRICE, (msg) => {
      const price = Number(msg?.price);
      if (!Number.isFinite(price)) return;
      btcPriceHistory.push(price);
      if (btcPriceHistory.length > 20) btcPriceHistory.shift();
    });
    console.log('[Bot] Binance price via NATS');
    return true;
  } catch (e) {
    console.warn('[Bot] NATS feeds unavailable —', e.message);
    if (natsBridge) {
      await natsBridge.close().catch(() => {});
      natsBridge = null;
    }
    return false;
  }
}

async function startNatsBot() {
  try {
    const { createNatsBridge } = require('./lib/natsBridge');
    const { SUBJECTS } = require('./lib/nats/subjects');
    natsBridge = natsBridge || createNatsBridge({ name: 'bot' });
    await natsBridge.connect();
    await natsBridge.subscribe(SUBJECTS.BOT_CONTROL, async (msg) => {
      const cmd = msg?.command;
      if (cmd === 'stop') {
        botShouldStop = true;
        console.log('[Bot] stop requested via NATS');
        setTimeout(() => process.exit(0), 250);
      }
      if (cmd === 'strategy' && msg?.strategyId) {
        console.log(`[Bot] strategy change requested (${msg.strategyId}) — restart bot to apply`);
      }
      if (cmd === 'window' && msg?.mode) {
        console.log(`[Bot] window mode requested (${msg.mode}) — feed publisher handles ingest`);
      }
    }, { dedup: false });
    await publishBotStatus({ startedAt: Date.now() });
  } catch (e) {
    console.warn('[Bot] NATS control unavailable — continuing without NATS:', e.message);
    if (natsBridge) {
      await natsBridge.close().catch(() => {});
      natsBridge = null;
    }
  }
}

async function tick() {
  if (botShouldStop) return;
  await publishBotStatus();
  // #region agent log
  fetch('http://127.0.0.1:7837/ingest/d970f366-0641-4e67-8ab4-8e310df24ef3',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5a7232'},body:JSON.stringify({sessionId:'5a7232',runId:'pre-fix',hypothesisId:'H3',location:'bot.js:98',message:'tick start',data:{bankroll,openPositionCount:Object.keys(openPositions).length,historyLen:btcPriceHistory.length},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (bankroll <= 0) {
    console.log('[Bot] Bankroll depleted — cannot enter new trades');
    return;
  }

  const cycleStart = new Date();
  console.log(`\n[Cycle] ${cycleStart.toISOString()} | bankroll=$${bankroll.toFixed(2)} | openPositions=${Object.keys(openPositions).length}`);

  // Get active markets
  let markets;
  try {
    markets = await getActiveBTCShortMarkets();
  } catch (e) {
    console.error('[Bot] Failed to fetch markets:', e.message);
    return;
  }

  // Refresh resolved windows for resolution exits.
  try {
    recentResolutions = await getRecentResolvedMarkets(25);
  } catch (e) {
    console.warn('[Cycle] Failed to refresh resolved markets; continuing with last known values');
  }
  const resolvedMap = new Map(
    recentResolutions.map((m) => [m.conditionId, m.outcome])
  );

  // Check existing positions first, even if market is no longer active.
  for (const position of Object.values(openPositions)) {
    const maybeActive = markets.find((m) => m.conditionId === position.market.conditionId);
    await checkExit(maybeActive || position.market, position, resolvedMap.get(position.market.conditionId) || null);
  }

  if (!markets.length) {
    console.log('[Cycle] No BTC 5m/15m markets available');
    return;
  }

  console.log(`[Cycle] Active BTC markets selected: ${markets.length}`);
  markets.slice(0, 5).forEach((market, idx) => {
    const secs = Math.max(0, Math.round((market.endTime - Date.now()) / 1000));
    console.log(
      `[Cycle]  ${idx + 1}. ${market.windowMinutes}m | ${marketLabel(market)} | tte=${secs}s | ${market.question}`
    );
  });

  // Check all active markets in parallel
  await Promise.all(markets.map(market => checkMarket(market)));
}

async function checkMarket(market) {
  const now           = Date.now();
  const timeRemaining = Math.max(0, (market.endTime - now) / 1000);
  // #region agent log
  fetch('http://127.0.0.1:7837/ingest/d970f366-0641-4e67-8ab4-8e310df24ef3',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5a7232'},body:JSON.stringify({sessionId:'5a7232',runId:'pre-fix',hypothesisId:'H4',location:'bot.js:136',message:'market timing computed',data:{conditionId:market.conditionId,endTime:market.endTime,now,timeRemaining},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  if (!isWithinTradingWindow(market, timeRemaining)) return;

  // Skip if we already have a position in this market
  if (openPositions[market.conditionId]) {
    await checkExit(market, openPositions[market.conditionId]);
    return;
  }

  try {
    // Strategy evaluation: safe long-only YES entries.
    const [yesPrice, liquidityDepth] = await Promise.all([
      getMidpoint(market.tokenIdYes),
      getLiquidityDepth(market.tokenIdYes),
    ]);
    const decision = ACTIVE_STRATEGY.decide({
      market,
      yesPrice,
      liquidityDepth,
      bankroll,
      btcPriceHistory,
    });
    const entryEligible = Boolean(decision?.entryEligible);
    const strategyStop = Number.isFinite(decision?.stop) ? decision.stop : ACTIVE_STRATEGY.stop;
    console.log(
      `[EntryCheck] ${marketLabel(market)} | strategy=${STRATEGY_ID} | yes=${fmtPrice(yesPrice)} | met=${entryEligible ? 'YES' : 'NO'}`
    );
    try {
      const { publishDashboardEvent } = require('./dashboard/hub');
      publishDashboardEvent({
        type: 'entry_check',
        detail: `${market.windowMinutes}m ${marketLabel(market)} ${decision?.reason || ''} met=${entryEligible ? 'YES' : 'NO'}`,
        yesPrice,
        marketId: market.conditionId,
        strategyId: STRATEGY_ID,
        timestamp: Date.now(),
      });
    } catch (_) {}
    if (!entryEligible) return;

    // Full-balance compounding position size.
    const betSize = Math.max(0, parseFloat(bankroll.toFixed(2)));
    if (betSize <= 0) return;

    const signal = {
      edgeCase: decision?.edgeCase || ACTIVE_STRATEGY.id,
      tier: 1,
      direction: 'YES',
      entry: yesPrice,
      target: 1.0,
      stop: Number.isFinite(strategyStop) ? strategyStop : STOP_THRESHOLD,
      holdToResolution: true,
      reason: decision?.reason || ACTIVE_STRATEGY.description || 'Strategy entry',
    };

    console.log(
      `[PositionOpen] ${marketLabel(market)} | size=$${betSize.toFixed(2)} | entry=${fmtPrice(yesPrice)} | stop=${signal.stop.toFixed(3)} | depth=${liquidityDepth.toFixed(0)}`
    );

    // Track position
    const tradeId = `${PAPER_TRADE ? 'paper' : 'live'}-${market.conditionId}-${++liveTradeSeq}`;
    openPositions[market.conditionId] = {
      tradeId,
      signal,
      entryPrice: yesPrice,
      betSize,
      entryTime:  now,
      market,
      timeRemainingAtEntry: Math.round(timeRemaining),
      orderbookDepthAtEntry: liquidityDepth,
      bankrollBefore: bankroll,
      strategyId: STRATEGY_ID,
    };

    emitTradeEvent({
      eventType: 'entry',
      tradeId,
      mode: PAPER_TRADE ? 'paper' : 'live',
      marketId: market.conditionId,
      question: market.question,
      edgeCase: signal.edgeCase,
      tier: signal.tier,
      direction: signal.direction,
      entryTime: now,
      timeRemainingAtEntry: Math.round(timeRemaining),
      entryPrice: signal.entry,
      target: signal.target,
      stop: signal.stop,
      betSize,
      orderbookDepth: liquidityDepth,
      signalReason: signal.reason,
      strategyId: STRATEGY_ID,
      bankrollBefore: bankroll,
    });

  } catch (e) {
    console.error(`[Bot] Error checking market ${market.conditionId}:`, e.message);
  }
}

/**
 * Check if an open position should be exited (stop-loss/resolution)
 */
async function checkExit(market, position, resolvedOutcome = null) {
  const { signal, entryPrice, betSize } = position;
  const now           = Date.now();
  const timeRemaining = Math.max(0, (market.endTime - now) / 1000);

  try {
    const currentPrice = await getMidpoint(market.tokenIdYes);
    const unrealizedPnl = betSize * ((currentPrice - entryPrice) / entryPrice);
    console.log(
      `[Position] ${marketLabel(market)} | yes=${fmtPrice(currentPrice)} | entry=${fmtPrice(entryPrice)} | unrealized=$${unrealizedPnl.toFixed(2)}`
    );

    const stopThreshold = Number.isFinite(signal?.stop) ? signal.stop : STOP_THRESHOLD;
    const exitByStop = currentPrice <= stopThreshold;
    const exitByResolutionSignal = resolvedOutcome === 'Yes' || resolvedOutcome === 'No';
    const exitByTime = timeRemaining <= 0;
    const shouldExit = exitByStop || exitByResolutionSignal || exitByTime;
    if (!shouldExit) return;

    let exitPrice = currentPrice;
    let exitReason = 'resolution';
    if (exitByStop) {
      exitPrice = Math.min(currentPrice, stopThreshold);
      exitReason = 'stop_loss';
    } else if (exitByResolutionSignal) {
      exitPrice = resolvedOutcome === 'Yes' ? 1.0 : 0.0;
      exitReason = 'resolution';
    }

    const won = exitPrice > entryPrice;
    const pnl = betSize * ((exitPrice - entryPrice) / entryPrice);
    const bankrollBefore = bankroll;

    bankroll = Math.max(0, bankroll + pnl);

    delete openPositions[market.conditionId];

    const icon = won ? '✓' : '✗';
    console.log(
      `[ExitTrigger] ${marketLabel(market)} | reason=${exitReason} | stop@${stopThreshold.toFixed(2)} | resolved=${resolvedOutcome || 'n/a'}`
    );
    console.log(`[Exit ${icon}] ${signal.direction} | exit=${fmtPrice(exitPrice)} | pnl=$${pnl.toFixed(2)} | bankroll=$${bankroll.toFixed(2)}`);

    emitTradeEvent({
      eventType: 'exit',
      tradeId: position.tradeId,
      mode: PAPER_TRADE ? 'paper' : 'live',
      marketId: market.conditionId,
      question: market.question,
      edgeCase: signal.edgeCase,
      tier: signal.tier,
      direction: signal.direction,
      entryTime: position.entryTime,
      exitTime: now,
      holdSeconds: Math.round((now - position.entryTime) / 1000),
      timeRemainingAtEntry: position.timeRemainingAtEntry,
      entryPrice,
      exitPrice,
      target: signal.target,
      stop: signal.stop,
      betSize,
      orderbookDepth: position.orderbookDepthAtEntry,
      signalReason: signal.reason,
      exitReason,
      won,
      pnl,
      bankrollBefore,
      bankrollAfter: bankroll,
    });

  } catch (e) {
    console.error(`[Bot] Error checking exit:`, e.message);
  }
}

// ─────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────

async function main() {
  await setup();

  // Run tick every 30 seconds
  setInterval(tick, POLL_INTERVAL);

  // First tick immediately
  await tick();
}

main().catch(console.error);