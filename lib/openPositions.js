/**
 * Helpers for open position collections (tradeId-keyed map or array rows).
 */

function listOpenPositions(openPositions = {}) {
  if (Array.isArray(openPositions)) return openPositions;
  return Object.values(openPositions || {});
}

function conditionIdFromPosition(pos) {
  return pos?.market?.conditionId || pos?.marketId || null;
}

function openConditionIds(openPositions = {}) {
  const ids = new Set();
  for (const pos of listOpenPositions(openPositions)) {
    const cid = conditionIdFromPosition(pos);
    if (cid) ids.add(cid);
  }
  return ids;
}

function positionsForMarket(openPositions = {}, conditionId) {
  if (!conditionId) return [];
  return listOpenPositions(openPositions).filter(
    (pos) => conditionIdFromPosition(pos) === conditionId
  );
}

function openCountForMarket(openPositions = {}, conditionId) {
  return positionsForMarket(openPositions, conditionId).length;
}

function positionByTradeId(openPositions = {}, tradeId) {
  if (!tradeId) return null;
  if (Array.isArray(openPositions)) {
    return openPositions.find((p) => p.tradeId === tradeId) || null;
  }
  return openPositions[tradeId] || null;
}

module.exports = {
  listOpenPositions,
  conditionIdFromPosition,
  openConditionIds,
  positionsForMarket,
  openCountForMarket,
  positionByTradeId,
};
