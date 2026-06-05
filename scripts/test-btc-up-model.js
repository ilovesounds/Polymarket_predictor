#!/usr/bin/env node
/**
 * Smoke test: microstructure engine + btc up model from synthetic aggTrades.
 * Run: node scripts/test-btc-up-model.js
 */

const { createMicrostructureEngine } = require('../signals/microstructure');
const { computeBtcUpPrediction, compareToPolymarket, buildBtcUpModelView } = require('../signals/btcUpModel');
const { getStrategy } = require('../signals/strategies_runtime');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

const engine = createMicrostructureEngine();
const baseTs = Date.now() - 55_000;
let price = 100_000;

// Cold start — few trades
for (let i = 0; i < 3; i += 1) {
  engine.ingestTrade({
    price: price + i,
    qty: 0.01,
    isBuyerMaker: false,
    sourceTs: baseTs + i * 1000,
  });
}
let snap = engine.getSnapshot();
let pred = computeBtcUpPrediction(snap);
assert(pred.pUp === 0.5 && pred.coldStart === true, 'cold start should be 0.5');

// Bullish flow: buy-initiated dominance
for (let i = 0; i < 80; i += 1) {
  price += 2;
  engine.ingestTrade({
    price,
    qty: 0.05 + (i % 3) * 0.01,
    isBuyerMaker: false,
    sourceTs: baseTs + 10_000 + i * 500,
  });
}
snap = engine.getSnapshot();
pred = computeBtcUpPrediction(snap);
assert(pred.ready === true, 'should be ready after enough trades');
assert(pred.pUp > 0.5, `bullish flow should raise pUp, got ${pred.pUp}`);

const cmp = compareToPolymarket(pred.pUp, 0.55, 0.05);
assert(cmp.edgePct != null, 'edge pct should compute');
console.log(
  `OK P(up)=${(pred.pUp * 100).toFixed(1)}% | Poly YES=55% | edge=${cmp.edgePct >= 0 ? '+' : ''}${cmp.edgePct.toFixed(1)}% | entry=${cmp.entrySignal}`,
);

// Strategy path: microstructure_edge requires ready + entrySignal
const strategy = getStrategy('microstructure_edge');
const coldDecision = strategy.decide({ yesPrice: 0.55, btcUpModel: null, edgeThreshold: 0.05 });
assert(coldDecision.entryEligible === false, 'cold start should block entry');

const view = buildBtcUpModelView(pred, 0.55);
const hotDecision = strategy.decide({ yesPrice: 0.55, btcUpModel: view, edgeThreshold: 0.05 });
assert(hotDecision.entryEligible === Boolean(view.ready && view.entrySignal), 'strategy should mirror model gates');

const det = getStrategy('deterministic_yes_50');
const detDecision = det.decide({ yesPrice: 0.52 });
assert(detDecision.entryEligible === true, 'deterministic_yes_50 unchanged at 0.52');

console.log('All btc up model checks passed.');
