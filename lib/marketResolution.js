/**
 * Detect resolved / expired Polymarket markets for position settlement.
 */

const RESOLUTION_PRICE_HIGH = 0.98;
const RESOLUTION_PRICE_LOW = 0.02;
const DEFAULT_POST_END_GRACE_MS = 30_000;

function marketEndMs(market) {
  const end = market?.endTime ?? market?.endDate;
  if (Number.isFinite(end)) return end;
  if (end) {
    const parsed = new Date(end).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isMarketPastEnd(market, graceMs = DEFAULT_POST_END_GRACE_MS) {
  const endMs = marketEndMs(market);
  if (!Number.isFinite(endMs)) return false;
  return Date.now() >= endMs + graceMs;
}

function inferOutcomeFromYesPrice(yesPrice) {
  if (!Number.isFinite(yesPrice)) return null;
  if (yesPrice >= RESOLUTION_PRICE_HIGH) return 'Yes';
  if (yesPrice <= RESOLUTION_PRICE_LOW) return 'No';
  return null;
}

/**
 * Resolve winning side for settlement. Prefers Gamma outcome; falls back to
 * YES mid when the market window has ended.
 * @returns {'Yes'|'No'|null}
 */
function resolveSettlementOutcome({ gammaOutcome, yesPrice, market, requireExpired = true }) {
  if (gammaOutcome === 'Yes' || gammaOutcome === 'No') return gammaOutcome;
  if (requireExpired && !isMarketPastEnd(market)) return null;
  return inferOutcomeFromYesPrice(yesPrice);
}

/** Exit price per share for a YES or NO position at settlement. */
function settlementExitPrice(outcome, direction = 'YES') {
  if (outcome !== 'Yes' && outcome !== 'No') return null;
  const side = String(direction || 'YES').toUpperCase();
  const yesWins = outcome === 'Yes';
  if (side === 'YES') return yesWins ? 1.0 : 0.0;
  return yesWins ? 0.0 : 1.0;
}

function isNearResolutionPrice(yesPrice) {
  return inferOutcomeFromYesPrice(yesPrice) != null;
}

module.exports = {
  RESOLUTION_PRICE_HIGH,
  RESOLUTION_PRICE_LOW,
  DEFAULT_POST_END_GRACE_MS,
  marketEndMs,
  isMarketPastEnd,
  inferOutcomeFromYesPrice,
  resolveSettlementOutcome,
  settlementExitPrice,
  isNearResolutionPrice,
};
