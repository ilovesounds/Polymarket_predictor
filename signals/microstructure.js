/**
 * Binance aggTrade microstructure signals for BTC spot.
 *
 * OFI proxy: true L2 order-book deltas are unavailable on aggTrade alone.
 * We approximate bid/ask volume deltas by classifying each trade as
 * buy-initiated (m=false, buyer is taker) vs sell-initiated (m=true, seller is taker),
 * then OFI = (takerBuyVol - takerSellVol) / totalVol over a rolling 60s window.
 *
 * Binance `m` flag: m=true → buyer is maker → seller is taker (sell-initiated).
 *                    m=false → seller is maker → buyer is taker (buy-initiated).
 */

const OFI_WINDOW_MS = 60_000;
const AGGRESSOR_WINDOW_MS = 60_000;
const VOL_WINDOW_MS = 30_000;
const MOMENTUM_LOOKBACK_MS = 60_000;

const OFI_BUY = 0.6;
const OFI_SELL = 0.4;
const AGG_BULL = 0.65;
const AGG_BEAR = 0.35;

/** @typedef {{ ts: number, price: number, qty: number, isTakerBuy: boolean }} AggTrade */

class TimedRing {
  /**
   * @param {number} windowMs
   * @param {number} maxLen
   */
  constructor(windowMs, maxLen = 8000) {
    this.windowMs = windowMs;
    this.maxLen = maxLen;
    /** @type {AggTrade[]} */
    this.buf = [];
  }

  /** @param {AggTrade} trade */
  push(trade) {
    this.buf.push(trade);
    this.prune(trade.ts);
  }

  /** @param {number} [now] */
  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    while (this.buf.length && this.buf[0].ts < cutoff) this.buf.shift();
    if (this.buf.length > this.maxLen) {
      this.buf.splice(0, this.buf.length - this.maxLen);
    }
  }

  /** @param {number} [now] */
  snapshot(now = Date.now()) {
    this.prune(now);
    return this.buf;
  }
}

class PriceRing {
  /**
   * @param {number} maxAgeMs
   * @param {number} maxLen
   */
  constructor(maxAgeMs, maxLen = 4000) {
    this.maxAgeMs = maxAgeMs;
    this.maxLen = maxLen;
    /** @type {Array<{ ts: number, price: number }>} */
    this.buf = [];
  }

  push(price, ts = Date.now()) {
    if (!Number.isFinite(price)) return;
    this.buf.push({ ts, price });
    this.prune(ts);
  }

  /** @param {number} [now] */
  prune(now = Date.now()) {
    const cutoff = now - this.maxAgeMs;
    while (this.buf.length && this.buf[0].ts < cutoff) this.buf.shift();
    if (this.buf.length > this.maxLen) {
      this.buf.splice(0, this.buf.length - this.maxLen);
    }
  }

  /** @returns {number|null} */
  latest(now = Date.now()) {
    this.prune(now);
    if (!this.buf.length) return null;
    return this.buf[this.buf.length - 1].price;
  }

  /**
   * Price nearest to (now - lookbackMs).
   * @param {number} lookbackMs
   * @param {number} [now]
   * @returns {number|null}
   */
  priceAtLookback(lookbackMs, now = Date.now()) {
    this.prune(now);
    if (!this.buf.length) return null;
    const target = now - lookbackMs;
    let best = this.buf[0];
    let bestDist = Math.abs(best.ts - target);
    for (const pt of this.buf) {
      const dist = Math.abs(pt.ts - target);
      if (dist < bestDist) {
        best = pt;
        bestDist = dist;
      }
    }
    return best.price;
  }
}

function labelOfi(value) {
  if (!Number.isFinite(value)) return 'neutral';
  if (value > OFI_BUY) return 'bullish';
  if (value < OFI_SELL) return 'bearish';
  return 'neutral';
}

function labelAggressor(value) {
  if (!Number.isFinite(value)) return 'neutral';
  if (value > AGG_BULL) return 'bullish';
  if (value < AGG_BEAR) return 'bearish';
  return 'neutral';
}

function labelMomentum(value) {
  if (!Number.isFinite(value)) return 'neutral';
  if (value > 0) return 'bullish';
  if (value < 0) return 'bearish';
  return 'neutral';
}

function labelVol(value, baseline = null) {
  if (!Number.isFinite(value)) return 'neutral';
  if (Number.isFinite(baseline) && baseline > 0 && value > baseline * 2) return 'elevated';
  if (value > 0.00015) return 'elevated';
  return 'normal';
}

function labelComposite(ofiLabel, momentumLabel, ofi, momentum) {
  const ofiBull = ofiLabel === 'bullish' || (Number.isFinite(ofi) && ofi > OFI_BUY);
  const ofiBear = ofiLabel === 'bearish' || (Number.isFinite(ofi) && ofi < OFI_SELL);
  const momBull = momentumLabel === 'bullish' || (Number.isFinite(momentum) && momentum > 0);
  const momBear = momentumLabel === 'bearish' || (Number.isFinite(momentum) && momentum < 0);
  if (ofiBull && momBull) return { label: 'bullish', conviction: 'high' };
  if (ofiBear && momBear) return { label: 'bearish', conviction: 'high' };
  if ((ofiBull && momBear) || (ofiBear && momBull)) return { label: 'neutral', conviction: 'low' };
  return { label: 'neutral', conviction: 'low' };
}

/**
 * @param {AggTrade[]} trades
 */
function takerVolumes(trades) {
  let takerBuy = 0;
  let takerSell = 0;
  for (const t of trades) {
    if (t.isTakerBuy) takerBuy += t.qty;
    else takerSell += t.qty;
  }
  return { takerBuy, takerSell, total: takerBuy + takerSell };
}

/**
 * Realized vol: sqrt(sum of squared log returns) over window.
 * @param {AggTrade[]} trades
 */
function realizedVol(trades) {
  if (trades.length < 2) return null;
  let sumSq = 0;
  let prev = trades[0].price;
  for (let i = 1; i < trades.length; i++) {
    const p = trades[i].price;
    if (prev > 0 && p > 0) {
      const r = Math.log(p / prev);
      sumSq += r * r;
    }
    prev = p;
  }
  return Math.sqrt(sumSq);
}

function createMicrostructureEngine() {
  const tradeWindow = new TimedRing(Math.max(OFI_WINDOW_MS, AGGRESSOR_WINDOW_MS));
  const volWindow = new TimedRing(VOL_WINDOW_MS);
  const priceRing = new PriceRing(MOMENTUM_LOOKBACK_MS + 5000);
  let lastSnapshot = null;
  let tradeCount = 0;

  /**
   * @param {{ price: number, qty: number, isBuyerMaker: boolean, sourceTs?: number, receivedAt?: number }} trade
   */
  function ingestTrade(trade) {
    const ts = trade.sourceTs || trade.receivedAt || Date.now();
    const price = trade.price;
    const qty = trade.qty;
    if (!Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0) return lastSnapshot;

    // m=true → buyer is maker → sell-initiated; m=false → buy-initiated
    const isTakerBuy = trade.isBuyerMaker === false;
    const row = { ts, price, qty, isTakerBuy };

    tradeWindow.push(row);
    volWindow.push(row);
    priceRing.push(price, ts);
    tradeCount += 1;

    return computeSnapshot(ts);
  }

  function computeSnapshot(now = Date.now()) {
    const trades60 = tradeWindow.snapshot(now);
    const trades30 = volWindow.snapshot(now);
    const { takerBuy, takerSell, total } = takerVolumes(trades60);

    const ofi = total > 0 ? (takerBuy - takerSell) / total : null;
    const aggressorRatio = total > 0 ? takerBuy / total : null;
    const vol30 = realizedVol(trades30);
    const midNow = priceRing.latest(now);
    const midPast = priceRing.priceAtLookback(MOMENTUM_LOOKBACK_MS, now);
    const momentum = Number.isFinite(midNow) && Number.isFinite(midPast) && midPast !== 0
      ? (midNow - midPast) / midPast
      : null;

    const ofiLabel = labelOfi(ofi);
    const aggLabel = labelAggressor(aggressorRatio);
    const momLabel = labelMomentum(momentum);
    const volLabel = labelVol(vol30);
    const composite = labelComposite(ofiLabel, momLabel, ofi, momentum);

    lastSnapshot = {
      timestamp: now,
      tradeCount60s: trades60.length,
      tradeCountTotal: tradeCount,
      mid: midNow,
      signals: {
        ofi: {
          value: ofi,
          label: ofiLabel,
          thresholds: { buy: OFI_BUY, sell: OFI_SELL },
          windowMs: OFI_WINDOW_MS,
        },
        aggressorRatio: {
          value: aggressorRatio,
          label: aggLabel,
          thresholds: { bullish: AGG_BULL, bearish: AGG_BEAR },
          windowMs: AGGRESSOR_WINDOW_MS,
          takerBuyVol: takerBuy,
          takerSellVol: takerSell,
        },
        realizedVol30s: {
          value: vol30,
          label: volLabel,
          windowMs: VOL_WINDOW_MS,
          interpretation: 'vol spike → 5-min distribution widens, odds may lag',
        },
        momentum60s: {
          value: momentum,
          label: momLabel,
          lookbackMs: MOMENTUM_LOOKBACK_MS,
          midNow,
          midPast,
        },
        compositeConviction: {
          label: composite.label,
          conviction: composite.conviction,
          ofi,
          momentum,
          interpretation: composite.conviction === 'high'
            ? 'OFI and momentum agree'
            : 'OFI/momentum disagree or weak',
        },
      },
    };
    return lastSnapshot;
  }

  function getSnapshot() {
    return lastSnapshot || computeSnapshot();
  }

  return { ingestTrade, getSnapshot, computeSnapshot };
}

/** Shared singleton for dashboard + optional strategy hooks. */
const sharedEngine = createMicrostructureEngine();

/**
 * Parse Binance aggTrade payload.
 * @param {Record<string, unknown>} data
 */
function parseAggTrade(data) {
  const price = parseFloat(data.p);
  const qty = parseFloat(data.q);
  const sourceTs = Number(data.T || data.E) || Date.now();
  const isBuyerMaker = Boolean(data.m);
  return { price, qty, isBuyerMaker, sourceTs };
}

module.exports = {
  createMicrostructureEngine,
  sharedEngine,
  parseAggTrade,
  OFI_BUY,
  OFI_SELL,
  AGG_BULL,
  AGG_BEAR,
};
