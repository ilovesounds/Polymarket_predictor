function fmtPrice(price) {
  if (!Number.isFinite(price)) return 'n/a';
  return price.toFixed(3);
}

function marketLabel(market) {
  return `${market.conditionId.slice(0, 8)}…`;
}

function formatWindowLabel(windowMinutes) {
  if (windowMinutes === 1440) return '1d';
  return `${windowMinutes}m`;
}

const { isWithinEntryWindow } = require('../lib/botProfile');

function isWithinTradingWindow(market, timeRemainingSec, entryRules = {}) {
  return isWithinEntryWindow(market, timeRemainingSec, entryRules);
}

module.exports = {
  fmtPrice,
  marketLabel,
  formatWindowLabel,
  isWithinTradingWindow,
};
