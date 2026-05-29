/**
 * backtest/engine.js
 * Backtesting engine using real Polymarket historical data
 *
 * Two data sources:
 *   1. CLOB /trades endpoint (reconstruct from raw trades)
 *   2. PolyBackTest API (pre-built sub-second snapshots)
 *
 * Usage:
 *   node backtest/engine.js
 */

const {
  getAllowedWindows,
  getRecentResolvedMarkets,
  getTradeHistory,
  getPriceHistory1Min,
} = require('../api/polymarket_runtime');
const { emitTradeEvent } = require('../logging/tradeEvents');

const POLYBACKTEST_API = 'https://polybacktest.com/api/v1';
const STARTING_BANKROLL = 5;

function getBacktestWindowMinutes() {
  const allowed = getAllowedWindows();
  if (allowed.length === 1) return allowed[0];
  if (allowed.includes(15)) return 15;
  if (allowed.includes(5)) return 5;
  if (allowed.includes(1440)) return 1440;
  return 15;
}

function windowDurationMs(windowMinutes) {
  return windowMinutes * 60_000;
}

// ─────────────────────────────────────────────
// DATA FETCHING
// ─────────────────────────────────────────────

/**
 * Fetch historical BTC 15-min windows from PolyBackTest
 * Returns array of windows with full price series
 */
async function fetchPolyBackTestData(limit = 200, windowMinutes = 15) {
  const type = windowMinutes === 5 ? 'btc-5m'
    : windowMinutes === 1440 ? 'btc-1d'
    : 'btc-15m';
  try {
    const res = await fetch(
      `${POLYBACKTEST_API}/markets?type=${type}&limit=${limit}`
    );
    if (!res.ok) throw new Error(`PolyBackTest returned ${res.status}`);
    return res.json();
  } catch (e) {
    console.warn('[Backtest] PolyBackTest unavailable, falling back to CLOB trades');
    return null;
  }
}

/**
 * Reconstruct 1-min OHLCV from raw CLOB trades
 * This is the fallback when PolyBackTest is unavailable
 */
function reconstructFromTrades(trades, windowStartMs, windowEndMs, bucketMs = 60_000) {
  const candles = {};

  trades.forEach((trade) => {
    if (trade.t < windowStartMs || trade.t > windowEndMs) return;

    const bucket = Math.floor(trade.t / bucketMs) * bucketMs;

    if (!candles[bucket]) {
      candles[bucket] = {
        t: bucket,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        vol: trade.size,
      };
    } else {
      const c = candles[bucket];
      c.high = Math.max(c.high, trade.price);
      c.low = Math.min(c.low, trade.price);
      c.close = trade.price;
      c.vol += trade.size;
    }
  });

  return Object.values(candles).sort((a, b) => a.t - b.t);
}

function reconstructFromPriceHistory(history, windowStartMs, windowEndMs) {
  const points = (history || []).filter((p) => p.t >= windowStartMs && p.t <= windowEndMs);
  if (!points.length) return [];

  return points.map((p) => ({
    t: p.t,
    open: p.p,
    high: p.p,
    low: p.p,
    close: p.p,
    vol: 0,
  }));
}

async function buildWindowCandles(market, polyBackData, index) {
  const windowMinutes = market.windowMinutes || getBacktestWindowMinutes();
  const durationMs = windowDurationMs(windowMinutes);
  const windowEndMs = market.endTime;
  const windowStartMs = windowEndMs - durationMs;
  const bucketMs = windowMinutes <= 5 ? 15_000
    : windowMinutes >= 1440 ? 300_000
    : 60_000;

  if (polyBackData?.windows?.[index]?.candles?.length) {
    return polyBackData.windows[index].candles;
  }

  let candles = [];
  const trades = await getTradeHistory(market.conditionId);
  const yesTrades = trades.filter((t) => {
    if (market.tokenIdYes && t.asset) {
      return String(t.asset) === String(market.tokenIdYes);
    }
    return String(t.outcome || '').toLowerCase() === 'up';
  });
  if (yesTrades.length) {
    candles = reconstructFromTrades(yesTrades, windowStartMs, windowEndMs, bucketMs);
  }

  if (candles.length < 2 && market.tokenIdYes) {
    const history = await getPriceHistory1Min(
      market.tokenIdYes,
      Math.max(1, Math.ceil(windowMinutes / 60) + 1)
    );
    candles = reconstructFromPriceHistory(history, windowStartMs, windowEndMs);
  }

  return candles;
}

// ─────────────────────────────────────────────
// CORE BACKTEST RUNNER
// ─────────────────────────────────────────────

/**
 * Simulate deterministic strategy for one 15-min window
 * Buy YES at >= 0.50, stop at 0.45, otherwise hold to resolution.
 */
function simulateWindow(candles, windowMeta, bankroll, recentResolutions) {
  const minCandles = 2;
  if (!candles || candles.length < minCandles) return null;
  if (bankroll <= 0) return { signal: null, outcome: windowMeta.outcome, pnl: 0, won: null };

  const windowMinutes = windowMeta.windowMinutes || getBacktestWindowMinutes();
  const windowSeconds = windowMinutes * 60;

  const resolved    = windowMeta.outcome; // 'Yes' or 'No'
  let entryCandle = null;
  let entryPrice = null;

  // Replay candle by candle simulating deterministic entry.
  for (let i = 1; i < candles.length; i++) {
    const candle        = candles[i];
    const yesPrice  = candle.close;

    if (yesPrice >= 0.5) {
      entryPrice = yesPrice;
      entryCandle = candle;
      break;  // take first signal, don't re-enter
    }
  }

  if (!entryCandle) return { signal: null, outcome: resolved, pnl: 0, won: null };

  // Simulate exit — stop loss first, otherwise hold to resolution.
  const entryIdx = candles.findIndex(c => c.t === entryCandle.t);
  const entryTime = entryCandle.t;
  const timeRemainingAtEntry = Math.max(
    0,
    Math.round(windowSeconds - ((entryCandle.t - candles[0].t) / 1000))
  );
  let exitPrice  = resolved === 'Yes' ? 1.0 : 0.0;
  let exitReason = 'resolution';
  let exitTime = candles[candles.length - 1].t;

  for (let i = entryIdx + 1; i < candles.length; i++) {
    const c              = candles[i];
    if (c.low <= 0.45) {
      exitPrice  = 0.45;
      exitReason = 'stop_loss';
      exitTime = c.t;
      break;
    }
  }

  const won = exitPrice > entryPrice;
  const betSize  = bankroll;
  const pnl      = betSize * ((exitPrice - entryPrice) / entryPrice);
  const holdSeconds = Math.max(0, Math.round((exitTime - entryTime) / 1000));
  const bankrollAfter = Math.max(0, bankroll + pnl);
  const tradeId = `bt-${windowMeta.conditionId || 'unknown'}-${entryTime}`;
  const strategySignal = {
    edgeCase: 'YES_GE_0_50',
    tier: 1,
    direction: 'YES',
    reason: 'Deterministic YES entry at >= 0.50',
    target: 1.0,
    stop: 0.45,
  };

  return {
    signal:     strategySignal,
    tradeId,
    entryPrice,
    entryTime,
    exitPrice,
    exitTime,
    holdSeconds,
    timeRemainingAtEntry,
    exitReason,
    outcome:    resolved,
    won,
    pnl:        parseFloat(pnl.toFixed(4)),
    betSize,
    orderbookDepth: 5000,
    bankrollBefore: bankroll,
    bankrollAfter: parseFloat(bankrollAfter.toFixed(2)),
    marketId: windowMeta.conditionId,
    question: windowMeta.question,
    direction: strategySignal.direction,
    edgeCase:   strategySignal.edgeCase,
    tier:       strategySignal.tier,
    reason:     strategySignal.reason,
    target: strategySignal.target,
    stop: strategySignal.stop,
  };
}

// ─────────────────────────────────────────────
// FULL BACKTEST RUNNER
// ─────────────────────────────────────────────

async function runBacktest(numWindows = 200) {
  const windowMinutes = getBacktestWindowMinutes();
  const allowedWindows = getAllowedWindows();
  console.log(`\n${'═'.repeat(50)}`);
  const windowLabel = windowMinutes === 1440 ? '1D' : `${windowMinutes}-MIN`;
  console.log(`  POLYMARKET BTC ${windowLabel} BACKTEST ENGINE`);
  console.log(`  MARKET_WINDOW=${process.env.MARKET_WINDOW || '15'} (${allowedWindows.join(',')}m)`);
  console.log(`${'═'.repeat(50)}\n`);

  // Step 1: Fetch resolved markets
  console.log('[1/4] Fetching resolved BTC markets from Gamma API...');
  const resolvedMarkets = await getRecentResolvedMarkets(numWindows, allowedWindows);
  console.log(`      Found ${resolvedMarkets.length} resolved markets\n`);

  // Step 2: Try PolyBackTest first, fall back to CLOB trades
  console.log('[2/4] Fetching historical price data...');
  const polyBackData = await fetchPolyBackTestData(numWindows, windowMinutes);

  // Step 3: Simulate all windows
  console.log('[3/4] Simulating deterministic YES strategy across all windows...\n');

  const results = [];
  const strategyStats = { wins: 0, losses: 0, pnl: 0, skipped: 0 };
  let bankroll = STARTING_BANKROLL;
  const bankrollCurve = [bankroll];
  const recentResolutions = [];

  for (let i = 0; i < Math.min(resolvedMarkets.length, numWindows); i++) {
    const market = resolvedMarkets[i];

    const candles = await buildWindowCandles(market, polyBackData, i);

    const result = simulateWindow(candles, market, bankroll, [...recentResolutions]);
    if (!result) continue;

    results.push(result);
    recentResolutions.push({ outcome: market.outcome, conditionId: market.conditionId });
    if (recentResolutions.length > 10) recentResolutions.shift();  // keep last 10

    if (result.won !== null) {
      emitTradeEvent({
        eventType: 'entry',
        tradeId: result.tradeId,
        mode: 'backtest',
        marketId: result.marketId,
        question: result.question,
        edgeCase: result.edgeCase,
        tier: result.tier,
        direction: result.direction,
        entryTime: result.entryTime,
        timeRemainingAtEntry: result.timeRemainingAtEntry,
        entryPrice: result.entryPrice,
        target: result.target,
        stop: result.stop,
        betSize: result.betSize,
        orderbookDepth: result.orderbookDepth,
        signalReason: result.reason,
        bankrollBefore: result.bankrollBefore,
      });
      emitTradeEvent({
        eventType: 'exit',
        tradeId: result.tradeId,
        mode: 'backtest',
        marketId: result.marketId,
        question: result.question,
        edgeCase: result.edgeCase,
        tier: result.tier,
        direction: result.direction,
        entryTime: result.entryTime,
        exitTime: result.exitTime,
        holdSeconds: result.holdSeconds,
        timeRemainingAtEntry: result.timeRemainingAtEntry,
        entryPrice: result.entryPrice,
        exitPrice: result.exitPrice,
        target: result.target,
        stop: result.stop,
        betSize: result.betSize,
        orderbookDepth: result.orderbookDepth,
        signalReason: result.reason,
        exitReason: result.exitReason,
        won: result.won,
        pnl: result.pnl,
        bankrollBefore: result.bankrollBefore,
        bankrollAfter: result.bankrollAfter,
      });
      bankroll = Math.max(0, bankroll + result.pnl);
      bankrollCurve.push(parseFloat(bankroll.toFixed(2)));

      if (result.won) strategyStats.wins++;
      else strategyStats.losses++;
      strategyStats.pnl += result.pnl;
    } else {
      strategyStats.skipped++;
    }

    // Progress
    if (i % 25 === 0) {
      process.stdout.write(`      Progress: ${i}/${Math.min(resolvedMarkets.length, numWindows)} windows, bankroll: $${bankroll.toFixed(2)}\r`);
    }
  }

  // Step 4: Print results
  console.log('\n\n[4/4] BACKTEST RESULTS\n');
  console.log(`${'─'.repeat(50)}`);

  const trades      = results.filter(r => r.won !== null);
  const wins        = trades.filter(r => r.won);
  const losses      = trades.filter(r => !r.won);
  const totalPnL    = trades.reduce((s, r) => s + r.pnl, 0);
  const winRate     = trades.length ? wins.length / trades.length : 0;
  const tradePct    = results.length ? (trades.length / results.length * 100) : 0;

  console.log(`Total windows analyzed:  ${results.length}`);
  console.log(`Trades taken:            ${trades.length} (${tradePct.toFixed(1)}%)`);
  console.log(`Windows skipped:         ${results.length - trades.length}`);
  console.log(`Wins:                    ${wins.length}`);
  console.log(`Losses:                  ${losses.length}`);
  console.log(`Win rate:                ${(winRate*100).toFixed(1)}%`);
  console.log(`Total P&L:               $${totalPnL.toFixed(2)}`);
  console.log(`Final bankroll:          $${bankroll.toFixed(2)} (from $${STARTING_BANKROLL})`);
  console.log(`Return:                  ${((bankroll/STARTING_BANKROLL - 1)*100).toFixed(1)}%`);

  // Sharpe ratio
  const dailyReturns = [];
  for (let i = 1; i < bankrollCurve.length; i++) {
    dailyReturns.push((bankrollCurve[i] - bankrollCurve[i-1]) / bankrollCurve[i-1]);
  }
  const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const stdReturn = Math.sqrt(dailyReturns.map(r => (r-avgReturn)**2).reduce((a,b)=>a+b,0) / dailyReturns.length);
  const sharpe    = stdReturn > 0 ? (avgReturn / stdReturn * Math.sqrt(252)).toFixed(2) : 'N/A';

  console.log(`Sharpe ratio (ann.):     ${sharpe}`);

  console.log(`\n${'─'.repeat(50)}`);
  console.log('STRATEGY BREAKDOWN:\n');
  const strategyTrades = strategyStats.wins + strategyStats.losses;
  const strategyWr = strategyTrades ? ((strategyStats.wins / strategyTrades) * 100).toFixed(1) : '0.0';
  console.log(`  Deterministic YES>=0.50 | Trades: ${strategyTrades} | Win rate: ${strategyWr}% | P&L: $${strategyStats.pnl.toFixed(2)} | Skipped: ${strategyStats.skipped}`);

  console.log(`\n${'─'.repeat(50)}`);
  console.log('\nBANKROLL CURVE (every 20th data point):');
  bankrollCurve.filter((_, i) => i % 20 === 0).forEach((v, i) =>
    console.log(`  T+${String(i*20).padStart(4)}: $${v.toFixed(2)}`)
  );

  return { results, strategyStats, bankroll, bankrollCurve, winRate, sharpe };
}

// Run directly:
//   MARKET_WINDOW=5 node backtest/engine.js
//   BACKTEST_WINDOWS=100 MARKET_WINDOW=5 node backtest/engine.js
if (require.main === module) {
  const numWindows = Number(process.env.BACKTEST_WINDOWS || 200);
  runBacktest(numWindows).catch(console.error);
}

module.exports = {
  runBacktest,
  simulateWindow,
  reconstructFromTrades,
  reconstructFromPriceHistory,
  buildWindowCandles,
  getBacktestWindowMinutes,
};