/**
 * Strategy Lab param payloads for dashboard WS + HTTP.
 */
const { computeAllMarketParams } = require('../signals/marketParams');
const { getActivePreset } = require('../lib/strategyLab');
const { resolveSizingConfig, previewBetSize } = require('../lib/betSizing');

let lastLabParams = null;

function buildLabParamsPayload(market, book, betSizeUsdc = null) {
  if (!market || !book) return null;
  const activePreset = getActivePreset();
  const sizingConfig = resolveSizingConfig(activePreset);
  const bankroll = Number.isFinite(betSizeUsdc)
    ? betSizeUsdc
    : Number.parseFloat(process.env.STARTING_CASH || process.env.STARTING_BANKROLL || '20');
  const bet = previewBetSize(bankroll, sizingConfig, { liquidityDepth: 50_000 }).betSize
    || bankroll;

  const { params, gate } = computeAllMarketParams(book, {
    marketMeta: market,
    betSizeUsdc: bet,
    thresholds: activePreset,
  });

  const payload = {
    source: 'lab',
    type: 'params',
    timestamp: Date.now(),
    market: {
      conditionId: market.conditionId,
      question: market.question,
      windowMinutes: market.windowMinutes,
      endTime: market.endTime,
    },
    params,
    gate,
    preset: {
      id: activePreset.id,
      name: activePreset.name,
      gateMode: activePreset.gateMode,
      sizingMode: sizingConfig.sizingMode,
      fixedBetUsd: sizingConfig.fixedBetUsd,
      betPercent: sizingConfig.betPercent,
    },
  };

  lastLabParams = payload;
  return payload;
}

function getLastLabParams() {
  return lastLabParams;
}

module.exports = {
  buildLabParamsPayload,
  getLastLabParams,
};
