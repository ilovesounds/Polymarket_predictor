/**
 * Standalone latency probe — connect streams for N seconds and print a report.
 *
 *   node monitoring/latencyProbe.js
 *   node monitoring/latencyProbe.js --seconds 45
 */

const { connectBinanceFeed, pollChainlink, getChainlinkState } = require('../api/feeds_runtime');
const { getActiveBTCShortMarkets, subscribeClobAssets } = require('../api/polymarket_runtime');
const { getSnapshot, reset } = require('./latency');

const SECONDS = Number(process.argv.find((a) => a.startsWith('--seconds='))?.split('=')[1]
  || process.argv[process.argv.indexOf('--seconds') + 1]
  || 30);

function fmtMs(v) {
  if (!Number.isFinite(v)) return '—';
  return `${v} ms`;
}

function printReport(snap) {
  console.log('\n══════════════════════════════════════');
  console.log('  LATENCY REPORT');
  console.log(`  ${new Date(snap.timestamp).toISOString()}`);
  console.log('══════════════════════════════════════\n');

  const labels = {
    binance_ws: 'Binance WS (trade → local)',
    chainlink_oracle_age: 'Chainlink oracle age',
    chainlink_poll_rtt: 'Chainlink RPC round-trip',
    poly_ws_price: 'Polymarket WS price',
    poly_ws_trade: 'Polymarket WS trade',
    poly_midpoint_rest: 'Polymarket midpoint REST',
    poly_orderbook_rest: 'Polymarket orderbook REST',
    poly_orderbook_poll: 'Polymarket orderbook poll',
  };

  for (const [key, label] of Object.entries(labels)) {
    const s = snap.streams[key];
    if (!s?.count) {
      console.log(`${label.padEnd(32)} no samples`);
      continue;
    }
    console.log(
      `${label.padEnd(32)} n=${String(s.count).padStart(4)}  latest=${fmtMs(s.latest).padStart(8)}  p50=${fmtMs(s.p50).padStart(8)}  p95=${fmtMs(s.p95).padStart(8)}`
    );
  }

  const td = snap.tradeDepth;
  if (td.count) {
    console.log('\nTrade → orderbookDepthAtEntry');
    console.log(`  entries: ${td.count}`);
    console.log(`  depth fetch p50: ${fmtMs(td.depthFetch.p50)}`);
    console.log(`  decision→depth p50: ${fmtMs(td.decisionToDepth.p50)}`);
  } else {
    console.log('\nTrade → orderbookDepthAtEntry: no bot entries during probe');
  }
  console.log('');
}

async function main() {
  reset();
  console.log(`[LatencyProbe] collecting for ${SECONDS}s…`);

  connectBinanceFeed();

  const rpc = process.env.POLYGON_RPC;
  if (rpc) {
    try {
      const { ethers } = require('ethers');
      const provider = new ethers.providers.JsonRpcProvider(rpc);
      await pollChainlink(provider);
      setInterval(() => pollChainlink(provider), 30_000);
    } catch (e) {
      console.warn('[LatencyProbe] Chainlink unavailable:', e.message);
    }
  }

  try {
    const markets = await getActiveBTCShortMarkets([15]);
    const market = markets[0];
    if (market?.tokenIdYes) {
      subscribeClobAssets(
        [market.tokenIdYes, market.tokenIdNo].filter(Boolean),
        (_assetId, _price, _type, meta) => {
          if (meta?.sourceTs) {
            require('./latency').recordStreamLatency('poly_ws_price', {
              sourceTs: meta.sourceTs,
              receivedTs: meta.receivedAt || Date.now(),
            });
          }
        },
        () => {},
        { tokenIdYes: market.tokenIdYes, tokenIdNo: market.tokenIdNo }
      );
    }
  } catch (e) {
    console.warn('[LatencyProbe] Polymarket WS unavailable:', e.message);
  }

  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  const snap = getSnapshot();
  const cl = getChainlinkState();
  if (cl.updatedAt) {
    console.log(`[LatencyProbe] Chainlink price $${cl.price?.toFixed(2)} oracle age ${Date.now() - cl.updatedAt}ms`);
  }
  printReport(snap);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
