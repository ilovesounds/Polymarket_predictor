/**
 * Per-profile paper bankroll (isolated cash + positions).
 * File: data/paper-wallets/{profileId}.json
 */
const fs = require('fs');
const path = require('path');
const { settleAtResolution } = require('../paper/portfolio');

const DATA_DIR = path.join(__dirname, '..', 'data');
const WALLETS_DIR = path.join(DATA_DIR, 'paper-wallets');

function round2(n) {
  return Math.round(n * 100) / 100;
}

function ensureWalletsDir() {
  if (!fs.existsSync(WALLETS_DIR)) fs.mkdirSync(WALLETS_DIR, { recursive: true });
}

function walletPath(profileId) {
  const safe = String(profileId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(WALLETS_DIR, `${safe}.json`);
}

function defaultWallet(profileId, envStartingCash = 20) {
  const start = round2(Number(envStartingCash) || 20);
  return {
    profileId,
    cash: start,
    startingCash: start,
    netCashDelta: 0,
    realizedPnlTotal: 0,
    openPositions: [],
    tradeHistory: [],
    updatedAt: Date.now(),
  };
}

function normalizeWallet(raw, profileId, envStartingCash = 20) {
  const seed = defaultWallet(profileId, envStartingCash);
  if (!raw || typeof raw !== 'object') return seed;
  return {
    profileId,
    cash: round2(Number.isFinite(raw.cash) ? raw.cash : seed.cash),
    startingCash: round2(Number.isFinite(raw.startingCash) ? raw.startingCash : seed.startingCash),
    netCashDelta: round2(Number.isFinite(raw.netCashDelta) ? raw.netCashDelta : 0),
    realizedPnlTotal: round2(Number.isFinite(raw.realizedPnlTotal) ? raw.realizedPnlTotal : 0),
    openPositions: Array.isArray(raw.openPositions) ? raw.openPositions : [],
    tradeHistory: Array.isArray(raw.tradeHistory) ? raw.tradeHistory : [],
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function loadPaperWallet(profileId, envStartingCash = 20) {
  ensureWalletsDir();
  const file = walletPath(profileId);
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return normalizeWallet(raw, profileId, envStartingCash);
    }
  } catch (_) {}
  const wallet = defaultWallet(profileId, envStartingCash);
  savePaperWallet(wallet);
  return wallet;
}

function savePaperWallet(wallet) {
  if (!wallet?.profileId) return wallet;
  ensureWalletsDir();
  const normalized = normalizeWallet(wallet, wallet.profileId);
  normalized.updatedAt = Date.now();
  fs.writeFileSync(walletPath(normalized.profileId), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function walletToPortfolioState(wallet) {
  return {
    mode: 'paper',
    cash: wallet.cash,
    startingCash: wallet.startingCash,
    netCashDelta: wallet.netCashDelta ?? 0,
    realizedPnlTotal: wallet.realizedPnlTotal ?? 0,
    openPositions: wallet.openPositions || [],
    tradeHistory: wallet.tradeHistory || [],
    updatedAt: wallet.updatedAt || Date.now(),
  };
}

function portfolioStateToWallet(profileId, portfolioState) {
  return savePaperWallet({
    profileId,
    cash: portfolioState.cash,
    startingCash: portfolioState.startingCash,
    netCashDelta: portfolioState.netCashDelta ?? 0,
    realizedPnlTotal: portfolioState.realizedPnlTotal ?? 0,
    openPositions: portfolioState.openPositions || [],
    tradeHistory: portfolioState.tradeHistory || [],
    updatedAt: portfolioState.updatedAt || Date.now(),
  });
}

/**
 * Settle one open position at resolution and update wallet state.
 * @returns {{ wallet: object, exitEvent: object }|null}
 */
function applyResolutionSettlement(wallet, position, outcome) {
  if (!wallet || !position) return null;
  const settlement = settleAtResolution(position, outcome, { cash: wallet.cash });
  if (!settlement) return null;

  const marketId = settlement.exitEvent.marketId;
  const tradeId = settlement.exitEvent.tradeId;
  const nextOpen = (wallet.openPositions || []).filter((pos) => {
    if (tradeId && pos.tradeId === tradeId) return false;
    if (marketId && (pos.marketId === marketId || pos.market?.conditionId === marketId)) return false;
    return true;
  });

  const historyEntry = {
    type: 'exit',
    tradeId: settlement.exitEvent.tradeId,
    logLine: settlement.exitEvent.logLine,
    direction: settlement.exitEvent.direction,
    shares: settlement.exitEvent.shares,
    entryPrice: settlement.exitEvent.entryPrice,
    exitPrice: settlement.exitEvent.exitPrice,
    betSize: settlement.exitEvent.betSize,
    pnl: settlement.exitEvent.pnl,
    won: settlement.exitEvent.won,
    exitReason: 'resolution',
    resolvedOutcome: outcome,
    question: settlement.exitEvent.question,
    windowMinutes: settlement.exitEvent.windowMinutes,
    windowLabel: settlement.exitEvent.windowLabel,
    marketId,
    cashAfter: settlement.cashAfter,
    timestamp: settlement.exitEvent.exitTime,
  };

  const updated = savePaperWallet({
    ...wallet,
    cash: settlement.cashAfter,
    realizedPnlTotal: round2((wallet.realizedPnlTotal || 0) + settlement.realizedPnlDelta),
    openPositions: nextOpen,
    tradeHistory: [historyEntry, ...(wallet.tradeHistory || [])].slice(0, 500),
  });

  return { wallet: updated, exitEvent: settlement.exitEvent };
}

module.exports = {
  WALLETS_DIR,
  loadPaperWallet,
  savePaperWallet,
  walletToPortfolioState,
  portfolioStateToWallet,
  applyResolutionSettlement,
  defaultWallet,
};
