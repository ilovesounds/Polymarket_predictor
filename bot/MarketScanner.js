/**
 * Gamma market fetch + CLOB enrichment (midpoint, book, spread, price history).
 */

const {
  getActiveBTCShortMarkets,
  getRecentResolvedMarkets,
  getMidpoint,
  getOrderBook,
  getLiquidityDepth,
  getPriceHistory1Min,
} = require('../api/polymarket_runtime');
const { isWithinTradingWindow } = require('./helpers');
const { partitionOpenMarkets } = require('../lib/marketSelection');
const { openConditionIds } = require('../lib/openPositions');

function bestFromBook(levels) {
  if (!levels?.length) return null;
  const price = parseFloat(levels[0][0]);
  return Number.isFinite(price) ? price : null;
}

function spreadFromBook(book) {
  const bid = bestFromBook(book?.bids);
  const ask = bestFromBook(book?.asks);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return { spread: null, spreadCents: null, bestBid: bid, bestAsk: ask };
  const spread = ask - bid;
  return {
    bestBid: bid,
    bestAsk: ask,
    spread,
    spreadCents: spread * 100,
  };
}

/**
 * Markets that need live orderbooks: open positions + tradable window entries.
 * @param {object[]} markets
 * @param {Record<string, object>} openPositions
 * @param {number[]} allowedWindows
 * @param {object} [entryRules]
 */
function buildWatchlist(markets, openPositions = {}, allowedWindows = [], entryRules = {}) {
  const now = Date.now();
  const ids = new Set();
  for (const m of markets || []) {
    if (!m?.conditionId) continue;
    if (!allowedWindows.includes(m.windowMinutes)) continue;
    const timeRemaining = Math.max(0, (m.endTime - now) / 1000);
    if (isWithinTradingWindow(m, timeRemaining, entryRules)) ids.add(m.conditionId);
  }
  for (const cid of openConditionIds(openPositions)) {
    ids.add(cid);
  }
  return (markets || []).filter((m) => ids.has(m.conditionId));
}

/**
 * Markets to evaluate each cycle: active window slots + open positions.
 * Unlike buildWatchlist, includes the full live window so EntryCheck runs
 * before the narrow entry-timing band (tte 30–270s on 5m).
 */
function buildEvalMarkets(markets, openPositions = {}, allowedWindows = []) {
  const { active } = partitionOpenMarkets(markets, allowedWindows);
  const ids = new Set(active.map((m) => m.conditionId));
  for (const cid of openConditionIds(openPositions)) {
    ids.add(cid);
  }
  return (markets || []).filter((m) => ids.has(m.conditionId));
}

class MarketScanner {
  /**
   * @param {{ allowedWindows?: number[], enrichPriceHistory?: boolean, priceHistoryHours?: number, priceBuffers?: import('../lib/priceRingBuffer').PriceBufferStore }} opts
   */
  constructor(opts = {}) {
    this.allowedWindows = opts.allowedWindows;
    this.enrichPriceHistory = Boolean(opts.enrichPriceHistory);
    this.priceHistoryHours = Number(opts.priceHistoryHours) || 1;
    this.priceBuffers = opts.priceBuffers || null;
  }

  async fetchActiveMarkets() {
    return getActiveBTCShortMarkets(this.allowedWindows);
  }

  async fetchRecentResolutions(limit = 25) {
    return getRecentResolvedMarkets(limit);
  }

  /**
   * Enrich a single market for strategy evaluation.
   * @param {object} market
   * @param {{ fetchOrderbook?: boolean, cachedYesPrice?: number|null }} [opts]
   * @returns {Promise<{ market: object, yesPrice: number, liquidityDepth: number, book: object, enriched: object }>}
   */
  async enrichForStrategy(market, opts = {}) {
    const tokenId = market.tokenIdYes;
    const fetchOrderbook = opts.fetchOrderbook !== false;
    const bufferedYes = this.priceBuffers?.latest(market.conditionId);
    const useBuffered = Number.isFinite(opts.cachedYesPrice)
      ? opts.cachedYesPrice
      : (Number.isFinite(bufferedYes) ? bufferedYes : null);

    const midPromise = Number.isFinite(useBuffered)
      ? Promise.resolve(useBuffered)
      : getMidpoint(tokenId);

    const bookPromise = fetchOrderbook
      ? getOrderBook(tokenId)
      : Promise.resolve({ bids: [], asks: [] });

    const [yesPrice, book] = await Promise.all([midPromise, bookPromise]);
    let liquidityDepth = 0;
    if (fetchOrderbook && book?.bids?.length) {
      const bidDepth = book.bids.reduce((s, [, sz]) => s + sz, 0);
      const askDepth = book.asks.reduce((s, [, sz]) => s + sz, 0);
      liquidityDepth = Math.min(bidDepth, askDepth);
    } else if (fetchOrderbook) {
      liquidityDepth = await getLiquidityDepth(tokenId);
    }

    const { bestBid, bestAsk, spread, spreadCents } = spreadFromBook(book);
    let priceHistory = [];
    if (this.priceBuffers) {
      priceHistory = this.priceBuffers.getPriceHistory(market.conditionId);
    }
    if (!priceHistory.length && this.enrichPriceHistory) {
      try {
        priceHistory = await getPriceHistory1Min(tokenId, this.priceHistoryHours);
      } catch (_) {
        priceHistory = [];
      }
    }
    const enriched = {
      yesPrice,
      bestBid,
      bestAsk,
      spread,
      spreadCents,
      liquidityDepth,
      book,
      priceHistory,
    };
    return { market, yesPrice, liquidityDepth, book, enriched };
  }

  /**
   * Parallel enrich for multiple markets (orderbooks only when in watchlist set).
   * @param {object[]} markets
   * @param {Set<string>} [watchlistIds]
   */
  async enrichMarketsParallel(markets, watchlistIds = null) {
    const tasks = (markets || []).map((market) => {
      const inWatchlist = !watchlistIds || watchlistIds.has(market.conditionId);
      return this.enrichForStrategy(market, { fetchOrderbook: inWatchlist })
        .then((result) => ({ status: 'fulfilled', value: result }))
        .catch((reason) => ({ status: 'rejected', reason, market }));
    });
    return Promise.all(tasks);
  }

  /**
   * Refresh midpoint + depth before entry (post-decision).
   */
  async refreshEntryQuotes(market) {
    const [yesPrice, liquidityDepth] = await Promise.all([
      getMidpoint(market.tokenIdYes),
      getLiquidityDepth(market.tokenIdYes),
    ]);
    return { yesPrice, liquidityDepth };
  }
}

module.exports = {
  MarketScanner,
  spreadFromBook,
  bestFromBook,
  buildWatchlist,
  buildEvalMarkets,
};
