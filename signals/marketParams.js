/**
 * Market microstructure parameters for strategy lab / entry gates.
 *
 * Orderbook shape: { bids: [[price, sizeShares], ...], asks: [[price, sizeShares], ...] }
 * Prices are YES-token probabilities (0–1). USDC at a level = price × sizeShares.
 *
 * Depth choice: we report **total** USDC (bid + ask) within N ticks of mid for display,
 * and **weakerSideUsd** = min(bidUsd, askUsd) for conservative liquidity gates (limiting
 * side caps how much you can trade without moving the book).
 */

const TICK_SIZE = Number.parseFloat(process.env.LAB_TICK_SIZE || '0.01');

function sortLevels(levels, side) {
  return [...(levels || [])]
    .filter(([p, s]) => Number.isFinite(p) && Number.isFinite(s) && s > 0)
    .sort((a, b) => (side === 'bid' ? b[0] - a[0] : a[0] - b[0]));
}

function computeMid(book) {
  const bids = sortLevels(book?.bids, 'bid');
  const asks = sortLevels(book?.asks, 'ask');
  const bestBid = bids[0]?.[0];
  const bestAsk = asks[0]?.[0];
  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) return (bestBid + bestAsk) / 2;
  if (Number.isFinite(bestAsk)) return bestAsk;
  if (Number.isFinite(bestBid)) return bestBid;
  return null;
}

function levelUsdc(price, sizeShares) {
  return price * sizeShares;
}

function levelsWithinTicks(levels, mid, ticksFromMid, side) {
  const band = ticksFromMid * TICK_SIZE;
  return sortLevels(levels, side).filter(([price]) => {
    if (!Number.isFinite(mid)) return true;
    if (side === 'bid') return price >= mid - band && price <= mid;
    return price >= mid && price <= mid + band;
  });
}

function sumLevelUsdc(levels) {
  return levels.reduce((sum, [price, size]) => sum + levelUsdc(price, size), 0);
}

function sumLevelShares(levels) {
  return levels.reduce((sum, [, size]) => sum + size, 0);
}

/**
 * Best-ask minus best-bid in probability units (1 unit = $1 per share at settlement).
 * Also exposed as cents (×100).
 */
function computeBidAskSpread(book) {
  const bids = sortLevels(book?.bids, 'bid');
  const asks = sortLevels(book?.asks, 'ask');
  const bestBid = bids[0]?.[0];
  const bestAsk = asks[0]?.[0];
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) {
    return { spread: null, spreadCents: null, bestBid, bestAsk, mid: computeMid(book) };
  }
  const spread = Math.max(0, bestAsk - bestBid);
  return {
    spread,
    spreadCents: spread * 100,
    bestBid,
    bestAsk,
    mid: (bestBid + bestAsk) / 2,
  };
}

/**
 * USDC within N ticks of mid on each side; total = bid + ask; weakerSide = min(bid, ask).
 */
function computeMarketDepthUsd(book, ticksFromMid = 3) {
  const mid = computeMid(book);
  const bidLevels = levelsWithinTicks(book?.bids, mid, ticksFromMid, 'bid');
  const askLevels = levelsWithinTicks(book?.asks, mid, ticksFromMid, 'ask');
  const bidUsd = sumLevelUsdc(bidLevels);
  const askUsd = sumLevelUsdc(askLevels);
  const totalUsd = bidUsd + askUsd;
  const weakerSideUsd = Math.min(bidUsd, askUsd);
  return {
    mid,
    ticksFromMid,
    tickSize: TICK_SIZE,
    bidUsd,
    askUsd,
    totalUsd,
    weakerSideUsd,
    bidShares: sumLevelShares(bidLevels),
    askShares: sumLevelShares(askLevels),
  };
}

/**
 * Prefer Gamma volume24hr / volume on market meta; else sum USDC from trades in last 24h.
 */
function computeVolume24h(marketMeta = {}, trades = null) {
  const gammaVol = Number(marketMeta.volume24h ?? marketMeta.volume24hr ?? marketMeta.volume);
  if (Number.isFinite(gammaVol) && gammaVol > 0) {
    return { volume24h: gammaVol, source: 'gamma' };
  }

  if (Array.isArray(trades) && trades.length) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let vol = 0;
    for (const t of trades) {
      const ts = t.t ?? t.timestamp ?? t.ts_ms;
      const ms = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
      if (!Number.isFinite(ms) || ms < cutoff) continue;
      const price = Number(t.price);
      const size = Number(t.size);
      if (Number.isFinite(price) && Number.isFinite(size)) vol += price * size;
      else if (Number.isFinite(size)) vol += size;
    }
    if (vol > 0) return { volume24h: vol, source: 'trades_estimate' };
  }

  return { volume24h: null, source: 'unknown' };
}

/**
 * Order book imbalance in [-1, 1] using share depth within N ticks of mid.
 * Positive = more bid-side size (buy pressure on YES).
 */
function computeOrderbookImbalance(book, ticksFromMid = 3) {
  const mid = computeMid(book);
  const bidLevels = levelsWithinTicks(book?.bids, mid, ticksFromMid, 'bid');
  const askLevels = levelsWithinTicks(book?.asks, mid, ticksFromMid, 'ask');
  const bidDepth = sumLevelShares(bidLevels);
  const askDepth = sumLevelShares(askLevels);
  const total = bidDepth + askDepth;
  if (total <= 0) return { imbalance: null, bidDepth, askDepth };
  return {
    imbalance: (bidDepth - askDepth) / total,
    bidDepth,
    askDepth,
    mid,
  };
}

/**
 * Walk the book for a USDC notional. side 'buy' hits asks; 'sell' hits bids.
 * Returns VWAP fill vs mid slippage (%).
 */
function computeSlippageEstimate(book, betSizeUsdc, side = 'buy') {
  const mid = computeMid(book);
  if (!Number.isFinite(mid) || !Number.isFinite(betSizeUsdc) || betSizeUsdc <= 0) {
    return {
      mid,
      fillPrice: null,
      slippagePct: null,
      slippageVsMid: null,
      filledUsdc: 0,
      unfilledUsdc: betSizeUsdc || 0,
      side,
    };
  }

  const levels = side === 'buy'
    ? sortLevels(book?.asks, 'ask')
    : sortLevels(book?.bids, 'bid');

  let remaining = betSizeUsdc;
  let totalCost = 0;
  let totalShares = 0;

  for (const [price, size] of levels) {
    if (price <= 0) continue;
    const levelUsdc = price * size;
    const takeUsdc = Math.min(remaining, levelUsdc);
    totalCost += takeUsdc;
    totalShares += takeUsdc / price;
    remaining -= takeUsdc;
    if (remaining <= 1e-9) break;
  }

  if (totalShares <= 0) {
    return {
      mid,
      fillPrice: null,
      slippagePct: null,
      slippageVsMid: null,
      filledUsdc: 0,
      unfilledUsdc: betSizeUsdc,
      side,
    };
  }

  const fillPrice = totalCost / totalShares;
  const slippageVsMid = fillPrice - mid;
  const slippagePct = side === 'buy'
    ? ((fillPrice - mid) / mid) * 100
    : ((mid - fillPrice) / mid) * 100;

  return {
    mid,
    fillPrice,
    slippagePct,
    slippageVsMid,
    filledUsdc: betSizeUsdc - remaining,
    unfilledUsdc: Math.max(0, remaining),
    side,
  };
}

function loadDefaultThresholds() {
  return {
    maxSpreadCents: Number.parseFloat(process.env.LAB_MAX_SPREAD_CENTS || '5'),
    minDepthUsd: Number.parseFloat(process.env.LAB_MIN_DEPTH_USD || '1000'),
    minVolume24h: Number.parseFloat(process.env.LAB_MIN_VOLUME_24H || '0'),
    maxImbalanceAbs: Number.parseFloat(process.env.LAB_MAX_IMBALANCE || '0.8'),
    maxSlippagePct: Number.parseFloat(process.env.LAB_MAX_SLIPPAGE_PCT || '2'),
    maxPositionPctOfLiquidity: Number.parseFloat(process.env.LAB_MAX_POSITION_PCT_LIQUIDITY || '5'),
    ticksFromMid: Number.parseInt(process.env.LAB_TICKS_FROM_MID || '3', 10),
    gateMode: String(process.env.LAB_GATE_MODE || 'warn').toLowerCase(),
  };
}

function evaluateParamGates(params, thresholds, context = {}) {
  const warnings = [];
  const blocks = [];
  const t = { ...loadDefaultThresholds(), ...thresholds };
  const edgeCents = Number(context.edgeCents);
  const betSizeUsdc = Number(context.betSizeUsdc);
  const spreadCents = params?.bidAskSpreadCents;

  if (Number.isFinite(spreadCents)) {
    const maxSpread = Number.isFinite(edgeCents) && edgeCents > 0
      ? Math.min(t.maxSpreadCents, edgeCents)
      : t.maxSpreadCents;
    if (spreadCents > maxSpread) {
      const msg = `Spread ${spreadCents.toFixed(1)}¢ exceeds limit ${maxSpread.toFixed(1)}¢`;
      blocks.push(msg);
    }
  }

  const depth = params?.weakerSideUsd ?? params?.marketDepthUsd;
  if (Number.isFinite(depth) && depth < t.minDepthUsd) {
    blocks.push(`Depth $${depth.toFixed(0)} below min $${t.minDepthUsd}`);
  }

  if (Number.isFinite(params?.volume24h) && t.minVolume24h > 0 && params.volume24h < t.minVolume24h) {
    blocks.push(`24h volume $${params.volume24h.toFixed(0)} below min $${t.minVolume24h}`);
  }

  if (Number.isFinite(params?.orderbookImbalance) && Math.abs(params.orderbookImbalance) > t.maxImbalanceAbs) {
    warnings.push(`Imbalance ${params.orderbookImbalance.toFixed(2)} exceeds ±${t.maxImbalanceAbs}`);
  }

  if (Number.isFinite(params?.slippagePct) && params.slippagePct > t.maxSlippagePct) {
    blocks.push(`Slippage ${params.slippagePct.toFixed(2)}% above max ${t.maxSlippagePct}%`);
  }

  if (Number.isFinite(betSizeUsdc) && Number.isFinite(depth) && depth > 0) {
    const pct = (betSizeUsdc / depth) * 100;
    if (pct > t.maxPositionPctOfLiquidity) {
      blocks.push(`Position ${pct.toFixed(1)}% of weaker-side depth exceeds ${t.maxPositionPctOfLiquidity}%`);
    }
  }

  const gateMode = t.gateMode === 'block' ? 'block' : (t.gateMode === 'off' ? 'off' : 'warn');
  const passed = blocks.length === 0;
  const shouldSkip = gateMode === 'block' && blocks.length > 0;

  return {
    passed,
    shouldSkip,
    gateMode,
    warnings,
    blocks,
    thresholds: t,
  };
}

function computeAllMarketParams(book, options = {}) {
  const ticksFromMid = options.ticksFromMid ?? loadDefaultThresholds().ticksFromMid;
  const betSizeUsdc = options.betSizeUsdc ?? Number(
    process.env.STARTING_CASH || process.env.STARTING_BANKROLL || '20'
  );
  const side = options.side || 'buy';

  const spread = computeBidAskSpread(book);
  const depth = computeMarketDepthUsd(book, ticksFromMid);
  const volume = computeVolume24h(options.marketMeta, options.trades);
  const imbalance = computeOrderbookImbalance(book, ticksFromMid);
  const slippage = computeSlippageEstimate(book, betSizeUsdc, side);

  const params = {
    bidAskSpread: spread.spread,
    bidAskSpreadCents: spread.spreadCents,
    bestBid: spread.bestBid,
    bestAsk: spread.bestAsk,
    mid: spread.mid ?? depth.mid ?? slippage.mid,
    marketDepthUsd: depth.totalUsd,
    weakerSideUsd: depth.weakerSideUsd,
    bidDepthUsd: depth.bidUsd,
    askDepthUsd: depth.askUsd,
    volume24h: volume.volume24h,
    volume24hSource: volume.source,
    orderbookImbalance: imbalance.imbalance,
    bidDepthShares: imbalance.bidDepth,
    askDepthShares: imbalance.askDepth,
    slippagePct: slippage.slippagePct,
    slippageFillPrice: slippage.fillPrice,
    slippageFilledUsdc: slippage.filledUsdc,
    slippageUnfilledUsdc: slippage.unfilledUsdc,
    betSizeUsdc,
    ticksFromMid,
    computedAt: Date.now(),
  };

  const gate = evaluateParamGates(params, options.thresholds, {
    edgeCents: options.edgeCents,
    betSizeUsdc,
  });

  return { params, gate, spread, depth, volume, imbalance, slippage };
}

module.exports = {
  TICK_SIZE,
  computeBidAskSpread,
  computeMarketDepthUsd,
  computeVolume24h,
  computeOrderbookImbalance,
  computeSlippageEstimate,
  computeMid,
  loadDefaultThresholds,
  evaluateParamGates,
  computeAllMarketParams,
};
