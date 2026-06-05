const CHAINLINK_AGGREGATOR = '0xc907E116054Ad103354f2D350FD2514433D57F6f';
const AGGREGATOR_ABI = [
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
];

let chainlinkState = { price: null, updatedAt: null, fetchedAt: null };
let chainlinkPollErrorLogged = false;
let binanceState = { price: null, updatedAt: null, sourceUpdatedAt: null, latencyMs: null };
let binanceWs = null;

function recordLatency(streamKey, opts) {
  try {
    require('../monitoring/latency').recordStreamLatency(streamKey, opts);
  } catch (_) {}
}

async function pollChainlink(provider) {
  const pollStart = Date.now();
  try {
    const { ethers } = require('ethers');
    const contract = new ethers.Contract(CHAINLINK_AGGREGATOR, AGGREGATOR_ABI, provider);
    const [, answer, , updatedAt] = await contract.latestRoundData();
    const fetchedAt = Date.now();
    const oracleUpdatedAt = Number(updatedAt) * 1000;
    chainlinkState = { price: Number(answer) / 10 ** 8, updatedAt: oracleUpdatedAt, fetchedAt };
    recordLatency('chainlink_poll_rtt', { sourceTs: pollStart, receivedTs: fetchedAt });
    recordLatency('chainlink_oracle_age', { sourceTs: oracleUpdatedAt, receivedTs: fetchedAt });
  } catch (e) {
    if (!chainlinkPollErrorLogged) {
      chainlinkPollErrorLogged = true;
      console.warn('[Chainlink] poll skipped:', e.message);
    }
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
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch (_) {
        return;
      }
      const receivedAt = Date.now();
      const sourceTs = Number(data.T || data.E) || receivedAt;
      const price = parseFloat(data.p);
      const qty = parseFloat(data.q);
      const isBuyerMaker = Boolean(data.m);
      const latencyMs = receivedAt - sourceTs;
      binanceState = { price, updatedAt: receivedAt, sourceUpdatedAt: sourceTs, latencyMs };
      recordLatency('binance_ws', { sourceTs, receivedTs: receivedAt, meta: { price } });
      if (onPrice) {
        onPrice(price, {
          sourceTs,
          receivedAt,
          latencyMs,
          trade: {
            price,
            qty,
            isBuyerMaker,
            sourceTs,
            receivedAt,
          },
        });
      }
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
