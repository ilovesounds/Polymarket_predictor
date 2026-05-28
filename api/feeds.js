/**
 * api/feeds.js
 * External price feeds:
 *   - Chainlink BTC/USD (oracle, Polygon on-chain)
 *   - Binance WebSocket (real-time, used for lag arb)
 */

// ─────────────────────────────────────────────
// CHAINLINK — on-chain BTC/USD oracle
// ─────────────────────────────────────────────

const CHAINLINK_AGGREGATOR = '0xc907E116054Ad103354f2D350FD2514433D57F6f'; // BTC/USD Polygon
const POLYGON_RPC          = 'https://polygon-rpc.com';

// Minimal ABI for latestRoundData
const AGGREGATOR_ABI = [
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
  'function decimals() view returns (uint8)',
];

let chainlinkState = {
  price:     null,
  updatedAt: null,  // ms timestamp of last on-chain update
  fetchedAt: null,  // ms timestamp of when WE last fetched
};

/**
 * Poll Chainlink BTC/USD — call every 30 seconds
 * Updates chainlinkState in place
 */
async function pollChainlink(provider) {
  try {
    // ethers.js v6
    const { ethers } = require('ethers');
    const contract   = new ethers.Contract(
      CHAINLINK_AGGREGATOR,
      AGGREGATOR_ABI,
      provider
    );

    const [, answer, , updatedAt] = await contract.latestRoundData();
    const decimals = 8; // BTC/USD always 8 decimals on Chainlink

    chainlinkState = {
      price:     Number(answer) / 10 ** decimals,
      updatedAt: Number(updatedAt) * 1000,  // convert to ms
      fetchedAt: Date.now(),
    };
  } catch (e) {
    console.error('[Chainlink] poll error:', e.message);
  }
}

function getChainlinkState() { return chainlinkState; }

/**
 * Age of last Chainlink oracle update in milliseconds
 * EC2 trigger: if age > 45_000ms AND Binance has moved → arb window open
 */
function getChainlinkAge() {
  if (!chainlinkState.updatedAt) return Infinity;
  return Date.now() - chainlinkState.updatedAt;
}

// ─────────────────────────────────────────────
// BINANCE WebSocket — real-time BTC/USDT trades
// ─────────────────────────────────────────────

let binanceState = {
  price:     null,
  updatedAt: null,
};

let binanceWs = null;

/**
 * Connect to Binance trade stream — updates binanceState on every trade
 * Reconnects automatically on disconnect
 */
function connectBinanceFeed(onPrice) {
  const WS_URL = 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade';

  function connect() {
    binanceWs = new WebSocket(WS_URL);

    binanceWs.onmessage = (msg) => {
      const data  = JSON.parse(msg.data);
      const price = parseFloat(data.p); // trade price

      binanceState = { price, updatedAt: Date.now() };
      if (onPrice) onPrice(price);
    };

    binanceWs.onerror = (e) => console.error('[Binance WS] error:', e.message);

    binanceWs.onclose = () => {
      console.log('[Binance WS] disconnected — reconnecting in 2s');
      setTimeout(connect, 2000);
    };
  }

  connect();
  return () => binanceWs?.close();
}

function getBinanceState() { return binanceState; }

// ─────────────────────────────────────────────
// DELTA CALCULATOR
// Used across multiple edge cases
// ─────────────────────────────────────────────

/**
 * Compute percentage delta of BTC from the window open price
 * windowOpenPrice: BTC price at start of the 15-min window
 * currentPrice:    current BTC price (Chainlink or Binance)
 */
function computeDelta(windowOpenPrice, currentPrice) {
  if (!windowOpenPrice) return 0;
  return (currentPrice - windowOpenPrice) / windowOpenPrice;
}

/**
 * Determine BTC momentum direction from last N Binance ticks
 * Returns 'up', 'down', or 'neutral'
 */
function computeMomentum(priceHistory, n = 3) {
  if (priceHistory.length < n) return 'neutral';
  const recent = priceHistory.slice(-n);
  const first  = recent[0];
  const last   = recent[recent.length - 1];
  const delta  = (last - first) / first;

  if (delta > 0.0002)  return 'up';
  if (delta < -0.0002) return 'down';
  return 'neutral';
}

module.exports = {
  pollChainlink,
  getChainlinkState,
  getChainlinkAge,
  connectBinanceFeed,
  getBinanceState,
  computeDelta,
  computeMomentum,
};