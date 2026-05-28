const { getChainlinkState, getChainlinkAge, getBinanceState, computeDelta } = require('../api/feeds_runtime');

function detectMomentumLock({ yesPrice, noPrice, timeRemaining, btcDelta }) {
  if (yesPrice > 0.85 && btcDelta > 0.0006 && timeRemaining > 120) return { edgeCase: 1, tier: 1, direction: 'YES', entry: yesPrice, target: 1.0, stop: 0, holdToResolution: true, confidence: 0.94, reason: 'Momentum lock YES' };
  if (noPrice > 0.85 && btcDelta < -0.0006 && timeRemaining > 120) return { edgeCase: 1, tier: 1, direction: 'NO', entry: noPrice, target: 1.0, stop: 0, holdToResolution: true, confidence: 0.94, reason: 'Momentum lock NO' };
  return null;
}
function detectChainlinkLagArb({ windowOpenPrice }) {
  const c = getChainlinkState(); const b = getBinanceState();
  if (!c.price || !b.price || !windowOpenPrice) return null;
  const chainlinkAge = getChainlinkAge();
  const binanceDelta = computeDelta(windowOpenPrice, b.price);
  const chainlinkMid = computeDelta(windowOpenPrice, c.price);
  if (chainlinkAge > 45000 && Math.abs(binanceDelta) > 0.0006 && Math.abs(binanceDelta - chainlinkMid) > 0.0004) return { edgeCase: 2, tier: 1, direction: binanceDelta > 0 ? 'YES' : 'NO', entry: 0.5, target: 0.62, stop: 0.46, holdToResolution: false, confidence: 0.82, reason: 'Chainlink lag arb' };
  return null;
}
function detectSignal(state) {
  const { yesPrice, noPrice, btcDelta, momentum, timeRemaining, windowOpenPrice } = state;
  return detectChainlinkLagArb({ windowOpenPrice }) ||
    detectMomentumLock({ yesPrice, noPrice, timeRemaining, btcDelta }) ||
    ((yesPrice >= 0.5 && yesPrice <= 0.56 && btcDelta > 0.0003 && momentum === 'up') ? { edgeCase: 8, tier: 3, direction: 'YES', entry: yesPrice, target: 0.79, stop: 0.46, holdToResolution: false, confidence: 0.57, reason: 'Core asymmetric YES' } : null) ||
    ((noPrice >= 0.5 && noPrice <= 0.56 && btcDelta < -0.0003 && momentum === 'down') ? { edgeCase: 8, tier: 3, direction: 'NO', entry: noPrice, target: 0.79, stop: 0.46, holdToResolution: false, confidence: 0.57, reason: 'Core asymmetric NO' } : null);
}

module.exports = { detectSignal };
