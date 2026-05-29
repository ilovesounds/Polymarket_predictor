/**
 * Publishes live Binance + Polymarket feeds to NATS (Node fallback until Rust feeds run).
 *   node feeds/natsPublisher.js
 */
const { connectBinanceFeed } = require('../api/feeds_runtime');
const {
  getActiveBTCShortMarkets,
  subscribeClobAssets,
  pairYesNoPrices,
  getMidpoint,
  getOrderBook,
} = require('../api/polymarket_runtime');
const {
  normalizePolyMode,
  modeToWindows,
  filterLiveMarketsForMode,
  pickPrimaryLiveMarket,
  primaryNeedsRoll,
} = require('../lib/marketSelection');
const { createNatsBridge } = require('../lib/natsBridge');
const { SUBJECTS } = require('../lib/nats/subjects');
const {
  binancePrice,
  polymarketPrice,
  polymarketOrderbook,
  polymarketMarkets,
  polymarketTrade,
} = require('../lib/nats/schemas');

const MARKET_REFRESH_MS = Number(process.env.MARKET_REFRESH_MS || 45_000);
const MARKET_ROLL_CHECK_MS = Number(process.env.MARKET_ROLL_CHECK_MS || 5_000);
const MIDPOINT_FALLBACK_MS = 5_000;
const ORDERBOOK_POLL_MS = 2_500;

const bridge = createNatsBridge({ name: 'feeds-publisher' });
const polySubscriptions = new Map();
let selectedPolyMode = String(process.env.DASHBOARD_POLY_MODE || '15m');
let selectedPrimaryMarketId = null;
let lastMarkets = [];
let polySubscriptionCycle = 0;

selectedPolyMode = normalizePolyMode(selectedPolyMode);

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

function closePolySubscriptions() {
  for (const handle of polySubscriptions.values()) {
    try {
      if (typeof handle?.close === 'function') handle.close();
    } catch (_) {}
  }
  polySubscriptions.clear();
}

function summarizeBookLevels(levels = [], side = 'bid') {
  const sorted = [...levels]
    .filter((lvl) => Number.isFinite(lvl[0]) && Number.isFinite(lvl[1]))
    .sort((a, b) => (side === 'bid' ? b[0] - a[0] : a[0] - b[0]));
  const ladder = sorted.slice(0, 10).map(([price, size]) => ({
    price: Number(price),
    size: Number(size),
  }));
  const depthTop5 = ladder.slice(0, 5).reduce((sum, row) => sum + row.size, 0);
  return {
    best: ladder[0] || null,
    depthTop5,
    totalDepth: sorted.reduce((sum, [, size]) => sum + size, 0),
    ladder,
  };
}

async function publishOrderbookSnapshot() {
  const market = getPrimaryMarket();
  if (!market?.tokenIdYes && !market?.tokenIdNo) return;
  const [yesBook, noBook] = await Promise.all([
    market.tokenIdYes ? getOrderBook(market.tokenIdYes).catch(() => null) : Promise.resolve(null),
    market.tokenIdNo ? getOrderBook(market.tokenIdNo).catch(() => null) : Promise.resolve(null),
  ]);
  const payload = polymarketOrderbook({
    market: {
      conditionId: market.conditionId,
      question: market.question,
      windowMinutes: market.windowMinutes,
      selectedMode: selectedPolyMode,
    },
    yes: {
      bid: summarizeBookLevels(yesBook?.bids || [], 'bid'),
      ask: summarizeBookLevels(yesBook?.asks || [], 'ask'),
    },
    no: {
      bid: summarizeBookLevels(noBook?.bids || [], 'bid'),
      ask: summarizeBookLevels(noBook?.asks || [], 'ask'),
    },
    via: 'clob_book_poll',
  });
  await bridge.publish(SUBJECTS.FEEDS_POLYMARKET_ORDERBOOK, payload);
}

async function subscribePolymarketMarkets() {
  const cycle = ++polySubscriptionCycle;
  closePolySubscriptions();

  let markets;
  try {
    markets = await getActiveBTCShortMarkets(modeToWindows(selectedPolyMode));
    lastMarkets = filterLiveMarketsForMode(markets, selectedPolyMode);
  } catch (e) {
    console.error('[feeds/nats] markets error:', e.message);
    return;
  }

  if (!lastMarkets.length) {
    selectedPrimaryMarketId = null;
    await bridge.publish(
      SUBJECTS.FEEDS_POLYMARKET_MARKETS,
      polymarketMarkets({ markets: [], selectedMode: selectedPolyMode, message: 'No active BTC 5m/15m/1d markets' })
    );
    return;
  }

  const primary = syncPrimaryMarketId();
  if (!primary) return;

  await bridge.publish(
    SUBJECTS.FEEDS_POLYMARKET_MARKETS,
    polymarketMarkets({
      selectedMode: selectedPolyMode,
      selectedMarketId: selectedPrimaryMarketId,
      markets: lastMarkets.map((m) => ({
        conditionId: m.conditionId,
        question: m.question,
        windowMinutes: m.windowMinutes,
        endTime: m.endTime,
        slug: m.slug,
      })),
    })
  );

  const emitPrices = async (market, yesP, noP, side, via = 'ws') => {
    if (cycle !== polySubscriptionCycle) return;
    if (market.conditionId !== selectedPrimaryMarketId) return;
    const { yes, no } = pairYesNoPrices(yesP, noP);
    if (yes == null && no == null) return;
    await bridge.publish(
      SUBJECTS.FEEDS_POLYMARKET_PRICE,
      polymarketPrice({
        yesPrice: yes,
        noPrice: no,
        side,
        via,
        market: {
          conditionId: market.conditionId,
          question: market.question,
          windowMinutes: market.windowMinutes,
          endTime: market.endTime,
          selectedMode: selectedPolyMode,
          isPrimary: true,
        },
      })
    );
  };

  const [seedYes, seedNo] = await Promise.all([
    primary.tokenIdYes ? getMidpoint(primary.tokenIdYes).catch(() => null) : null,
    primary.tokenIdNo ? getMidpoint(primary.tokenIdNo).catch(() => null) : null,
  ]);
  await emitPrices(primary, seedYes, seedNo, 'snapshot', 'midpoint');

  const assets = [primary.tokenIdYes, primary.tokenIdNo].filter(Boolean);
  if (assets.length) {
    const handle = subscribeClobAssets(
      assets,
      (assetId, price) => {
        if (assetId === primary.tokenIdYes) emitPrices(primary, price, null, 'yes', 'ws').catch(() => {});
        else if (assetId === primary.tokenIdNo) emitPrices(primary, null, price, 'no', 'ws').catch(() => {});
      },
      (err) => console.error('[feeds/nats] clob ws:', err?.message || err),
      {
        tokenIdYes: primary.tokenIdYes,
        tokenIdNo: primary.tokenIdNo,
        onTrade: (trade) => {
          bridge.publish(
            SUBJECTS.FEEDS_POLYMARKET_TRADES,
            polymarketTrade({
              ...trade,
              market: {
                conditionId: primary.conditionId,
                question: primary.question,
                windowMinutes: primary.windowMinutes,
                endTime: primary.endTime,
                selectedMode: selectedPolyMode,
                isPrimary: true,
              },
              via: 'clob_ws',
            })
          ).catch(() => {});
        },
      }
    );
    polySubscriptions.set(`${primary.conditionId}:clob`, handle);
  }
}

async function maybeRollPrimaryMarket() {
  const previousId = selectedPrimaryMarketId;
  const current = lastMarkets.find((m) => m.conditionId === previousId) || getPrimaryMarket();
  if (!primaryNeedsRoll(current)) return false;
  await subscribePolymarketMarkets();
  return Boolean(selectedPrimaryMarketId && selectedPrimaryMarketId !== previousId);
}

async function main() {
  await bridge.connect();
  console.log(`[feeds/nats] publishing to ${process.env.NATS_URL || 'nats://127.0.0.1:4222'}`);

  connectBinanceFeed(async (price) => {
    await bridge.publish(SUBJECTS.FEEDS_BINANCE_PRICE, binancePrice({ price, symbol: 'BTCUSDT' }));
  });

  await subscribePolymarketMarkets();
  await publishOrderbookSnapshot();
  setInterval(subscribePolymarketMarkets, MARKET_REFRESH_MS);
  setInterval(() => {
    maybeRollPrimaryMarket().catch(() => {});
  }, MARKET_ROLL_CHECK_MS);
  setInterval(() => publishOrderbookSnapshot().catch(() => {}), ORDERBOOK_POLL_MS);

  setInterval(async () => {
    if (!polySubscriptions.size) return;
    if (await maybeRollPrimaryMarket()) return;
    lastMarkets = filterLiveMarketsForMode(lastMarkets, selectedPolyMode);
    const market = getPrimaryMarket();
    if (!market) return;
    try {
      const [yesPrice, noPrice] = await Promise.all([
        market.tokenIdYes ? getMidpoint(market.tokenIdYes).catch(() => null) : null,
        market.tokenIdNo ? getMidpoint(market.tokenIdNo).catch(() => null) : null,
      ]);
      const { yes, no } = pairYesNoPrices(yesPrice, noPrice);
      if (yes == null && no == null) return;
      await bridge.publish(
        SUBJECTS.FEEDS_POLYMARKET_PRICE,
        polymarketPrice({
          yesPrice: yes,
          noPrice: no,
          side: 'snapshot',
          via: 'midpoint_poll',
          market: {
            conditionId: market.conditionId,
            question: market.question,
            windowMinutes: market.windowMinutes,
            endTime: market.endTime,
            selectedMode: selectedPolyMode,
            isPrimary: true,
          },
        })
      );
    } catch (_) {}
  }, MIDPOINT_FALLBACK_MS);

  bridge.subscribe(SUBJECTS.BOT_CONTROL, async (msg) => {
    if (msg?.command === 'window' && msg?.mode) {
      selectedPolyMode = normalizePolyMode(msg.mode);
      await subscribePolymarketMarkets();
    }
  }, { dedup: false });
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[feeds/nats] fatal:', e);
    process.exit(1);
  });
}

module.exports = { main };
