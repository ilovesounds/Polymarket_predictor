const CHAINLINK_AGGREGATOR = '0xc907E116054Ad103354f2D350FD2514433D57F6f';
const AGGREGATOR_ABI = [
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
];

let chainlinkState = { price: null, updatedAt: null, fetchedAt: null };
let binanceState = { price: null, updatedAt: null };
let binanceWs = null;

async function pollChainlink(provider) {
  try {
    const { ethers } = require('ethers');
    const contract = new ethers.Contract(CHAINLINK_AGGREGATOR, AGGREGATOR_ABI, provider);
    const [, answer, , updatedAt] = await contract.latestRoundData();
    chainlinkState = { price: Number(answer) / 10 ** 8, updatedAt: Number(updatedAt) * 1000, fetchedAt: Date.now() };
  } catch (e) {
    console.error('[Chainlink] poll error:', e.message);
  }
}

function getChainlinkState() { return chainlinkState; }
function getChainlinkAge() { return chainlinkState.updatedAt ? Date.now() - chainlinkState.updatedAt : Infinity; }

function connectBinanceFeed(onPrice) {
  const WS_URL = process.env.BINANCE_WS_URL || 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade';
  const WS = globalThis.WebSocket || require('ws');
  function connect() {
    binanceWs = new WS(WS_URL);
    binanceWs.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      const price = parseFloat(data.p);
      binanceState = { price, updatedAt: Date.now() };
      if (onPrice) onPrice(price);
    };
    binanceWs.onerror = (e) => console.error('[Binance WS] error:', e.message);
    binanceWs.onclose = () => setTimeout(connect, 2000);
  }
  connect();
  return () => binanceWs?.close();
}

function getBinanceState() { return binanceState; }

/** Binance 1m candle open at windowStartMs (Polymarket uses Chainlink; kline is a close proxy). */
async function fetchBinanceKlineOpen(windowStartMs) {
  const start = Math.floor(windowStartMs);
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${start}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
  const rows = await res.json();
  const open = rows?.[0]?.[1];
  const price = parseFloat(open);
  if (!Number.isFinite(price)) throw new Error('Invalid kline open');
  return price;
}

function computeDelta(windowOpenPrice, currentPrice) { return windowOpenPrice ? (currentPrice - windowOpenPrice) / windowOpenPrice : 0; }
function computeMomentum(priceHistory, n = 3) {
  if (priceHistory.length < n) return 'neutral';
  const recent = priceHistory.slice(-n);
  const delta = (recent[recent.length - 1] - recent[0]) / recent[0];
  if (delta > 0.0002) return 'up';
  if (delta < -0.0002) return 'down';
  return 'neutral';
}

module.exports = {
  pollChainlink,
  getChainlinkState,
  getChainlinkAge,
  connectBinanceFeed,
  getBinanceState,
  fetchBinanceKlineOpen,
  computeDelta,
  computeMomentum,
};
