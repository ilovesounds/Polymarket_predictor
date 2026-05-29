const HARD_FLOOR = 5;
const DAILY_LOSS_LIMIT = 0.15;
const FEE_RATE = 0.02;
const MIN_LIQUIDITY = 500;
const TIER_KELLY = { 1: 0.08, 2: 0.05, 3: 0.03 };

function computeBetSize(cash, signal, winRate, liquidityDepth) {
  if (cash < HARD_FLOOR || liquidityDepth < MIN_LIQUIDITY) return 0;
  const rr = (signal.target - signal.entry) / (signal.entry - signal.stop);
  const winFraction = rr / (rr + 1);
  const lossFraction = 1 / (rr + 1);
  const edge = winRate * winFraction - (1 - winRate) * lossFraction;
  if (edge <= 0) return 0;
  const fullKelly = edge / winFraction;
  const tieredKelly = fullKelly * (TIER_KELLY[signal.tier] / 0.08);
  let betSize = cash * tieredKelly * (1 - FEE_RATE);
  betSize = Math.min(betSize, liquidityDepth * 0.03);
  if (betSize < 0.5) return 0;
  return parseFloat(betSize.toFixed(2));
}

class BayesianTracker {
  constructor(priorWins = 10, priorLosses = 8) { this.wins = priorWins; this.losses = priorLosses; this.history = []; }
  update(edgeCase, won) { if (won) this.wins++; else this.losses++; this.history.push({ edgeCase, won, timestamp: Date.now() }); }
  get winRate() { return this.wins / (this.wins + this.losses); }
  winRateForEdgeCase(ec) { const t = this.history.filter((h) => h.edgeCase === ec); if (t.length < 5) return this.winRate; return t.filter((h) => h.won).length / t.length; }
  get shouldPause() { return this.winRate < 0.52 && (this.wins + this.losses) > 30; }
}

class DailyTracker {
  constructor(startingCash) { this.startOfDay = startingCash; this.currentCash = startingCash; this.dayStart = new Date().toISOString().slice(0, 10); this.paused = false; }
  checkDayReset(currentCash) { const today = new Date().toISOString().slice(0, 10); if (today !== this.dayStart) { this.startOfDay = currentCash; this.currentCash = currentCash; this.dayStart = today; this.paused = false; } }
  recordTrade(pnl, cash) { this.currentCash = cash; const dailyLoss = (cash - this.startOfDay) / this.startOfDay; if (dailyLoss < -DAILY_LOSS_LIMIT || cash <= HARD_FLOOR) this.paused = true; }
  get canTrade() { return !this.paused && this.currentCash > HARD_FLOOR; }
  get dailyPnLPct() { return ((this.currentCash - this.startOfDay) / this.startOfDay * 100).toFixed(2); }
}

function detectRegime(btcPrices) {
  if (btcPrices.length < 10) return 'unknown';
  const ranges = [];
  for (let i = 2; i < btcPrices.length; i++) {
    const s = btcPrices.slice(i - 2, i + 1);
    ranges.push(Math.max(...s) - Math.min(...s));
  }
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const recentRange = ranges.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const ratio = recentRange / avgRange;
  if (ratio < 0.5) return 'choppy';
  if (ratio > 2.5) return 'breakout';
  return 'trending';
}

module.exports = {
  computeBetSize,
  BayesianTracker,
  DailyTracker,
  detectRegime,
  HARD_FLOOR,
  FEE_RATE,
  TIER_KELLY,
  MIN_LIQUIDITY,
};
