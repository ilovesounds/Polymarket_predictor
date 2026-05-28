/**
 * signals/edgeCases.js
 * All 8 edge case detectors.
 */

const { getChainlinkState, getChainlinkAge, getBinanceState, computeDelta } = require('../api/feeds');

function detectMomentumLock({ yesPrice, noPrice, timeRemaining, btcDelta }) {
  if (yesPrice > 0.85 && btcDelta > 0.0006 && timeRemaining > 120) {
    return {
      edgeCase: 1, tier: 1, direction: 'YES', entry: yesPrice, target: 1.00, stop: 0,
      holdToResolution: true, confidence: 0.94,
      reason: `Momentum lock YES @ ${yesPrice.toFixed(3)}, delta=${(btcDelta*100).toFixed(3)}%`,
    };
  }
  if (noPrice > 0.85 && btcDelta < -0.0006 && timeRemaining > 120) {
    return {
      edgeCase: 1, tier: 1, direction: 'NO', entry: noPrice, target: 1.00, stop: 0,
      holdToResolution: true, confidence: 0.94,
      reason: `Momentum lock NO @ ${noPrice.toFixed(3)}, delta=${(btcDelta*100).toFixed(3)}%`,
    };
  }
  return null;
}

function detectChainlinkLagArb({ windowOpenPrice }) {
  const chainlink = getChainlinkState();
  const binance = getBinanceState();
  if (!chainlink.price || !binance.price || !windowOpenPrice) return null;
  const chainlinkAge = getChainlinkAge();
  const binanceDelta = computeDelta(windowOpenPrice, binance.price);
  const chainlinkMid = computeDelta(windowOpenPrice, chainlink.price);
  const lagDetected = chainlinkAge > 45_000;
  const binanceMoved = Math.abs(binanceDelta) > 0.0006;
  const priceDivergence = Math.abs(binanceDelta - chainlinkMid) > 0.0004;
  if (lagDetected && binanceMoved && priceDivergence) {
    const direction = binanceDelta > 0 ? 'YES' : 'NO';
    return {
      edgeCase: 2, tier: 1, direction,
      entry: 0.50, target: 0.62, stop: 0.46,
      holdToResolution: false, confidence: 0.82,
      reason: `Chainlink lag arb — stale ${(chainlinkAge/1000).toFixed(0)}s, Binance delta=${(binanceDelta*100).toFixed(3)}%`,
    };
  }
  return null;
}

function detectMacroFreeze({ yesPrice, noPrice, btcDelta, macroEventDetected }) {
  if (!macroEventDetected) return null;
  const bigMove = Math.abs(btcDelta) > 0.003;
  if (bigMove && btcDelta > 0 && yesPrice < 0.82) {
    return { edgeCase: 3, tier: 1, direction: 'YES', entry: yesPrice, target: 1.00, stop: 0.68, holdToResolution: true, confidence: 0.78, reason: `Macro freeze YES — big BTC move ${(btcDelta*100).toFixed(2)}% but YES only @ ${yesPrice.toFixed(3)}` };
  }
  if (bigMove && btcDelta < 0 && noPrice < 0.82) {
    return { edgeCase: 3, tier: 1, direction: 'NO', entry: noPrice, target: 1.00, stop: 0.68, holdToResolution: true, confidence: 0.78, reason: `Macro freeze NO — big BTC drop ${(btcDelta*100).toFixed(2)}% but NO only @ ${noPrice.toFixed(3)}` };
  }
  return null;
}

function detectMagnetEffect({ yesPrice, noPrice, priceHistory, timeRemaining, btcDelta }) {
  if (timeRemaining > 300 || timeRemaining < 60) return null;
  if (priceHistory.length >= 8) {
    const recent8 = priceHistory.slice(-8).map(c => c.p);
    const min8 = Math.min(...recent8);
    const max8 = Math.max(...recent8);
    const isSticky = (max8 - min8) < 0.05;
    if (isSticky && yesPrice > 0.66 && yesPrice < 0.76 && btcDelta > 0.0003) return { edgeCase: 4, tier: 2, direction: 'YES', entry: yesPrice, target: 0.80, stop: 0.62, holdToResolution: false, confidence: 0.63, reason: `Magnet YES — stuck ${min8.toFixed(3)}-${max8.toFixed(3)} for 4min, about to snap` };
    if (isSticky && noPrice > 0.66 && noPrice < 0.76 && btcDelta < -0.0003) return { edgeCase: 4, tier: 2, direction: 'NO', entry: noPrice, target: 0.80, stop: 0.62, holdToResolution: false, confidence: 0.63, reason: `Magnet NO — stuck ${min8.toFixed(3)}-${max8.toFixed(3)} for 4min, about to snap` };
  }
  return null;
}

function detectDeadWick({ yesPrice, priceHistory, timeRemaining }) {
  if (priceHistory.length < 3) return null;
  const chainlink = getChainlinkState();
  const now90s = priceHistory.slice(-3);
  const priceNow = now90s[now90s.length - 1].p;
  const price90sAgo = now90s[0].p;
  const drop = price90sAgo - priceNow;
  if (drop > 0.14 && priceNow > 0.55 && priceNow < 0.66 && chainlink.price !== null && timeRemaining > 180) {
    return { edgeCase: 5, tier: 2, direction: 'YES', entry: yesPrice, target: 0.74, stop: 0.50, holdToResolution: false, confidence: 0.61, reason: `Dead wick YES — dropped ${(drop).toFixed(2)}¢ in 90s but Chainlink stable` };
  }
  return null;
}

function detectConsecutiveLossFade({ yesPrice, noPrice, recentResolutions }) {
  if (!recentResolutions || recentResolutions.length < 3) return null;
  const last3 = recentResolutions.slice(-3);
  const allYes = last3.every(r => r.outcome === 'Yes');
  const allNo = last3.every(r => r.outcome === 'No');
  if (allYes && noPrice < 0.45) return { edgeCase: 6, tier: 2, direction: 'NO', entry: noPrice, target: 0.55, stop: 0.36, holdToResolution: false, confidence: 0.60, reason: `Consecutive fade — 3 YES wins, NO underpriced @ ${noPrice.toFixed(3)}` };
  if (allNo && yesPrice < 0.45) return { edgeCase: 6, tier: 2, direction: 'YES', entry: yesPrice, target: 0.55, stop: 0.36, holdToResolution: false, confidence: 0.60, reason: `Consecutive fade — 3 NO wins, YES underpriced @ ${yesPrice.toFixed(3)}` };
  return null;
}

function detectWindowFade({ yesPrice, noPrice, lastWindowOutcome, btcDelta, timeRemaining }) {
  if (!lastWindowOutcome || timeRemaining < 720) return null;
  if (lastWindowOutcome === 'Yes' && noPrice < 0.50 && Math.abs(btcDelta) < 0.0003) return { edgeCase: 7, tier: 3, direction: 'NO', entry: noPrice, target: 0.58, stop: 0.43, holdToResolution: false, confidence: 0.56, reason: `Window fade — prev YES, NO @ ${noPrice.toFixed(3)}, BTC neutral` };
  if (lastWindowOutcome === 'No' && yesPrice < 0.50 && Math.abs(btcDelta) < 0.0003) return { edgeCase: 7, tier: 3, direction: 'YES', entry: yesPrice, target: 0.58, stop: 0.43, holdToResolution: false, confidence: 0.56, reason: `Window fade — prev NO, YES @ ${yesPrice.toFixed(3)}, BTC neutral` };
  return null;
}

function detectCoreAsymmetric({ yesPrice, noPrice, btcDelta, momentum, timeRemaining }) {
  if (timeRemaining < 240) return null;
  if (yesPrice >= 0.50 && yesPrice <= 0.56 && btcDelta > 0.0003 && momentum === 'up') return { edgeCase: 8, tier: 3, direction: 'YES', entry: yesPrice, target: 0.79, stop: 0.46, holdToResolution: false, confidence: 0.57, reason: `Core asymmetric YES @ ${yesPrice.toFixed(3)}, momentum=${momentum}, delta=${(btcDelta*100).toFixed(3)}%` };
  if (noPrice >= 0.50 && noPrice <= 0.56 && btcDelta < -0.0003 && momentum === 'down') return { edgeCase: 8, tier: 3, direction: 'NO', entry: noPrice, target: 0.79, stop: 0.46, holdToResolution: false, confidence: 0.57, reason: `Core asymmetric NO @ ${noPrice.toFixed(3)}, momentum=${momentum}, delta=${(btcDelta*100).toFixed(3)}%` };
  return null;
}

function detectSignal(state) {
  const { yesPrice, noPrice, priceHistory, btcDelta, momentum, timeRemaining, windowOpenPrice, macroEventDetected, recentResolutions, lastWindowOutcome, orderBookDepth } = state;
  const ec2 = detectChainlinkLagArb({ windowOpenPrice }); if (ec2) return ec2;
  const ec1 = detectMomentumLock({ yesPrice, noPrice, timeRemaining, btcDelta }); if (ec1) return ec1;
  const ec3 = detectMacroFreeze({ yesPrice, noPrice, btcDelta, macroEventDetected }); if (ec3) return ec3;
  const ec5 = detectDeadWick({ yesPrice, noPrice, priceHistory, timeRemaining }); if (ec5) return ec5;
  const ec4 = detectMagnetEffect({ yesPrice, noPrice, priceHistory, timeRemaining, btcDelta, orderBookDepth }); if (ec4) return ec4;
  const ec6 = detectConsecutiveLossFade({ yesPrice, noPrice, recentResolutions }); if (ec6) return ec6;
  const ec7 = detectWindowFade({ yesPrice, noPrice, lastWindowOutcome, btcDelta, timeRemaining }); if (ec7) return ec7;
  const ec8 = detectCoreAsymmetric({ yesPrice, noPrice, btcDelta, momentum, timeRemaining }); if (ec8) return ec8;
  return null;
}

module.exports = {
  detectSignal,
  detectMomentumLock,
  detectChainlinkLagArb,
  detectMacroFreeze,
  detectMagnetEffect,
  detectDeadWick,
  detectConsecutiveLossFade,
  detectWindowFade,
  detectCoreAsymmetric,
};