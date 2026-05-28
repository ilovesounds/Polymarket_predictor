/**
 * risk/manager.js
 * Kelly sizing, liquidity gating, circuit breaker,
 * Bayesian win rate tracker, hard floor logic
 */

const HARD_FLOOR          = 5;     // USDC — stop trading if bankroll drops below this
const DAILY_LOSS_LIMIT    = 0.15;  // 15% max daily drawdown before pausing
const FEE_RATE            = 0.02;  // 2% Polymarket standard fee
const MIN_LIQUIDITY       = 500;   // minimum orderbook depth in USDC to enter

// ─────────────────────────────────────────────
// KELLY SIZING
// ─────────────────────────────────────────────

const TIER_KELLY = {
  1: 0.08,   // Tier 1: 8% of bankroll
  2: 0.05,   // Tier 2: 5% of bankroll
  3: 0.03,   // Tier 3: 3% of bankroll
};

/**
 * Compute Kelly bet size for a given signal
 * Adjusts for actual win probability and R:R ratio
 *
 * @param {number} bankroll    - current USDC balance
 * @param {object} signal      - from detectSignal()
 * @param {number} winRate     - Bayesian estimated win rate (0-1)
 * @param {number} liquidityDepth - available orderbook depth
 * @returns {number} bet size in USDC
 */
function computeBetSize(bankroll, signal, winRate, liquidityDepth) {
  if (bankroll <= HARD_FLOOR) return 0;

  // Liquidity gate — never bet more than 3% of available depth
  const liquidityCap = liquidityDepth * 0.03;
  if (liquidityDepth < MIN_LIQUIDITY) return 0;  // skip entirely

  // Edge = win*gain - loss*loss_fraction
  const rr           = (signal.target - signal.entry) / (signal.entry - signal.stop);
  const winFraction  = rr / (rr + 1);
  const lossFraction = 1 / (rr + 1);
  const edge         = winRate * winFraction - (1 - winRate) * lossFraction;

  if (edge <= 0) return 0;  // negative EV — skip

  // Full Kelly
  const fullKelly = edge / winFraction;

  // Apply tier multiplier (keeps sizing conservative for lower-conviction tiers)
  const tieredKelly = fullKelly * (TIER_KELLY[signal.tier] / 0.08);

  let betSize = bankroll * tieredKelly * (1 - FEE_RATE);

  // Apply liquidity cap
  betSize = Math.min(betSize, liquidityCap);

  // Minimum bet $0.50 to make fees worthwhile
  if (betSize < 0.50) return 0;

  return parseFloat(betSize.toFixed(2));
}

// ─────────────────────────────────────────────
// BAYESIAN WIN RATE TRACKER
// ─────────────────────────────────────────────

class BayesianTracker {
  constructor(priorWins = 10, priorLosses = 8) {
    // Start with weak prior: ~55% win rate
    this.wins   = priorWins;
    this.losses = priorLosses;
    this.history = [];  // { edgeCase, won, timestamp }
  }

  /**
   * Update after every trade resolution
   */
  update(edgeCase, won) {
    if (won) this.wins++;
    else this.losses++;

    this.history.push({ edgeCase, won, timestamp: Date.now() });
  }

  /**
   * Current Bayesian estimate of win rate
   */
  get winRate() {
    return this.wins / (this.wins + this.losses);
  }

  /**
   * Win rate for a specific edge case
   */
  winRateForEdgeCase(ec) {
    const trades = this.history.filter(h => h.edgeCase === ec);
    if (trades.length < 5) return this.winRate;  // fall back to global if < 5 samples
    const wins = trades.filter(h => h.won).length;
    return wins / trades.length;
  }

  /**
   * Confidence interval width (lower = more confident)
   */
  get uncertainty() {
    const n = this.wins + this.losses;
    return 1.96 * Math.sqrt((this.winRate * (1 - this.winRate)) / n);
  }

  /**
   * Should we pause trading? (win rate too low or too few samples)
   */
  get shouldPause() {
    return this.winRate < 0.52 && (this.wins + this.losses) > 30;
  }

  summary() {
    return {
      winRate:     this.winRate.toFixed(3),
      uncertainty: `±${this.uncertainty.toFixed(3)}`,
      totalTrades: this.wins + this.losses,
      shouldPause: this.shouldPause,
    };
  }
}

// ─────────────────────────────────────────────
// CIRCUIT BREAKER + DAILY TRACKING
// ─────────────────────────────────────────────

class DailyTracker {
  constructor(startingBankroll) {
    this.startOfDay    = startingBankroll;
    this.currentBankroll = startingBankroll;
    this.dayStart      = this._todayKey();
    this.trades        = [];
    this.paused        = false;
  }

  _todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Reset at midnight UTC
   */
  checkDayReset(currentBankroll) {
    const today = this._todayKey();
    if (today !== this.dayStart) {
      this.startOfDay      = currentBankroll;
      this.dayStart        = today;
      this.trades          = [];
      this.paused          = false;
      console.log(`[Risk] New day — bankroll reset to $${currentBankroll.toFixed(2)}`);
    }
  }

  /**
   * Record a trade result, check circuit breaker
   */
  recordTrade(pnl, bankroll) {
    this.currentBankroll = bankroll;
    this.trades.push({ pnl, timestamp: Date.now() });

    const dailyLoss = (bankroll - this.startOfDay) / this.startOfDay;

    if (dailyLoss < -DAILY_LOSS_LIMIT) {
      this.paused = true;
      console.warn(`[Risk] CIRCUIT BREAKER — daily loss ${(dailyLoss*100).toFixed(1)}%, pausing until tomorrow`);
    }

    if (bankroll <= HARD_FLOOR) {
      this.paused = true;
      console.warn(`[Risk] HARD FLOOR hit — bankroll $${bankroll.toFixed(2)}, stopping all trading`);
    }
  }

  get canTrade() {
    return !this.paused && this.currentBankroll > HARD_FLOOR;
  }

  get dailyPnL() {
    return this.currentBankroll - this.startOfDay;
  }

  get dailyPnLPct() {
    return ((this.currentBankroll - this.startOfDay) / this.startOfDay * 100).toFixed(2);
  }
}

// ─────────────────────────────────────────────
// REGIME DETECTOR
// Classifies the current BTC market condition
// Used to skip low-quality windows entirely
// ─────────────────────────────────────────────

/**
 * Classify the current BTC volatility regime
 * Returns 'trending' | 'breakout' | 'choppy'
 *
 * @param {number[]} btcPrices - recent BTC prices (last 20 readings)
 */
function detectRegime(btcPrices) {
  if (btcPrices.length < 10) return 'unknown';

  const n          = btcPrices.length;
  const ranges     = [];

  // Compute rolling 3-period ranges
  for (let i = 2; i < n; i++) {
    const slice = btcPrices.slice(i - 2, i + 1);
    ranges.push(Math.max(...slice) - Math.min(...slice));
  }

  const avgRange    = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const recentRange = ranges.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const ratio       = recentRange / avgRange;

  if (ratio < 0.5)  return 'choppy';   // low vol — no edge
  if (ratio > 2.5)  return 'breakout'; // explosive — fade or skip
  return 'trending';                    // sweet spot — trade
}

module.exports = {
  computeBetSize,
  BayesianTracker,
  DailyTracker,
  detectRegime,
  HARD_FLOOR,
  DAILY_LOSS_LIMIT,
  FEE_RATE,
  MIN_LIQUIDITY,
};