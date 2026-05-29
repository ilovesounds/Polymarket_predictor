/**
 * Main bot orchestrator: scan → evaluate → execute (paper).
 */

const { ethers } = require('ethers');
const { computeAllMarketParams } = require('../signals/marketParams');
const { getActivePreset } = require('../lib/strategyLab');
const {
  resolveSizingConfig,
  computePositionBetSize,
  previewBetSize,
  BayesianTracker,
} = require('../lib/betSizing');
const {
  pollChainlink,
  connectBinanceFeed,
} = require('../api/feeds_runtime');
const { emitTradeEvent, publishPortfolioSnapshot } = require('../logging/tradeEvents');
const { recordTradeDepthPipeline } = require('../monitoring/latency');
const { watchPostEntryDepth } = require('../monitoring/tradeDepthWatch');
const {
  calcShares,
  calcRealizedPnl,
  calcExitProceeds,
  computePortfolioMetrics,
  summarizeOpenPositions,
  buildOpenPositionRow,
  formatMarketWindowLabel,
} = require('../paper/portfolio');
const { getMidpoint, subscribeClobAssets, getMarketResolution } = require('../api/polymarket_runtime');
const {
  resolveSettlementOutcome,
  settlementExitPrice,
  isMarketPastEnd,
} = require('../lib/marketResolution');
const { isTradeLimitReached } = require('../lib/botRunConfig');
const { resolveStopThreshold, passesEntryPriceBand } = require('../lib/botProfile');
const { loadCashAdjustmentState } = require('../lib/cashAdjustments');
const { PriceBufferStore, BTC_BUFFER_KEY } = require('../lib/priceRingBuffer');
const { recordStreamLatency } = require('../monitoring/latency');
const { MarketScanner, buildWatchlist } = require('./MarketScanner');
const { StrategyRouter } = require('./StrategyRouter');
const { SessionManager } = require('./SessionManager');
const {
  fmtPrice,
  marketLabel,
  formatWindowLabel,
  isWithinTradingWindow,
} = require('./helpers');

class PolymarketBot {
  /**
   * @param {ReturnType<typeof import('./Config').loadConfig>} config
   */
  constructor(config) {
    this.config = config;
    this.paperTrade = config.paperTrade;
    this.priceBuffers = new PriceBufferStore(config.priceBufferSize);
    this.scanner = new MarketScanner({
      allowedWindows: config.allowedWindows,
      enrichPriceHistory: config.enrichPriceHistory,
      priceHistoryHours: config.priceHistoryHours,
      priceBuffers: this.priceBuffers,
    });
    this.router = new StrategyRouter(config.strategyIds);
    this.session = new SessionManager(config);
    this.sessionState = this.session.createState();
    this.strategyId = this.router.primaryId;

    this.cash = Number.isFinite(config.initialCash) ? config.initialCash : config.startingCash;
    this.startingCash = config.startingCash;
    this.envStartingCash = config.envStartingCash ?? config.startingCash;
    this.syncedNetCashDelta = config.netCashDelta || 0;
    this.bayesianTracker = new BayesianTracker();
    this.realizedPnlTotal = 0;
    this.openPositions = {};
    this.cachedMarkets = [];
    this.marketByToken = new Map();
    this.clobWsHandle = null;
    this.clobWsAssetKey = '';
    this.wsEvalTimers = new Map();
    this.wsExitTimers = new Map();
    this.recentResolutions = [];
    /** @type {Map<string, 'Yes'|'No'>} */
    this.resolutionByConditionId = new Map();
    this.liveTradeSeq = 0;
    this.lastActiveMarketKey = '';
    this.natsBridge = null;
    this.botShouldStop = false;
    this.botStopReason = null;
    this.positionValuationTimer = null;
    this.entryCheckLogCache = new Map();
    /** @type {Map<string, number>} */
    this.marketTradeCounts = new Map();
    this.pollTimer = null;
  }

  get entryRules() {
    return {
      entryMinSeconds: this.config.entryMinSeconds,
      entryMaxSeconds: this.config.entryMaxSeconds,
      entryMinPrice: this.config.entryMinPrice,
      entryMaxPrice: this.config.entryMaxPrice,
    };
  }

  get stopProfile() {
    return {
      stopLossPct: this.config.stopLossPct,
      stopLossPrice: this.config.stopLossPrice,
      stopThreshold: this.config.stopThreshold,
    };
  }

  async start() {
    await this.setup();
    this.pollTimer = setInterval(() => this.tick(), this.config.pollIntervalMs);
    await this.tick();
  }

  async setup() {
    console.log(`\n${'═'.repeat(50)}`);
    console.log('  POLYMARKET BTC 5M/15M/1D BOT');
    console.log(`  Mode: ${this.paperTrade ? 'PAPER TRADE' : '⚡ LIVE'}`);
    console.log(`  Strategy: ${this.router.label()}`);
    console.log(`  Market windows: ${this.config.allowedWindows.map(formatWindowLabel).join(', ')}`);
    console.log(`  Session: ${this.session.modeLabel(this.sessionState)}`);
    console.log(`  Starting cash: $${this.cash}`);
    const sizingCfg = resolveSizingConfig(getActivePreset());
    console.log(`  Sizing: ${sizingCfg.sizingMode}${sizingCfg.sizingMode === 'fixed' ? ` ($${sizingCfg.fixedBetUsd})` : ''}${sizingCfg.sizingMode === 'kelly' ? ` (cap ${(sizingCfg.kellyFractionCap * 100).toFixed(0)}%)` : ''}`);
    const exitLabel = this.config.exitMode === 'fixed_price'
      ? `fixed_price @ ${this.config.exitTargetPrice}`
      : 'resolve_only (hold to resolution)';
    const slParts = [];
    if (Number.isFinite(this.config.stopLossPct)) slParts.push(`${this.config.stopLossPct}%`);
    if (Number.isFinite(this.config.stopLossPrice)) slParts.push(`@${this.config.stopLossPrice}`);
    if (!slParts.length) slParts.push(`floor ${this.config.stopThreshold}`);
    console.log(`  Exit: ${exitLabel} | stop=${slParts.join(' ')} | maxEntries/market=${this.config.maxTradesPerMarket}`);
    console.log(`  Price path: ${this.config.useWsEval ? `CLOB WS (throttle ${this.config.wsEvalThrottleMs}ms) + ${this.config.pollIntervalMs / 1000}s discovery tick` : `REST poll ${this.config.pollIntervalMs / 1000}s`}`);
    console.log(`${'═'.repeat(50)}\n`);

    if (!this.config.privateKey) {
      console.warn('[Bot] No PRIVATE_KEY — running in paper trade mode');
    }

    if (this.config.botUseNatsFeeds) {
      const feedsOk = await this.startNatsFeeds();
      if (!feedsOk) this.startDirectBinanceFeed();
    } else {
      this.startDirectBinanceFeed();
    }

    if (this.config.useNats) {
      await this.startNatsBot();
    }

    try {
      const provider = new ethers.JsonRpcProvider(this.config.polygonRpc);
      await provider.getNetwork();
      setInterval(() => pollChainlink(provider), 30_000);
      await pollChainlink(provider);
    } catch (e) {
      console.warn('[Setup] Chainlink polling disabled (RPC unavailable)');
    }

    this.recentResolutions = await this.scanner.fetchRecentResolutions(10);
    console.log('[Setup] Binance feed connected');
    console.log('[Setup] Chainlink status initialized');
    console.log('[Setup] Ready to trade\n');
  }

  hasOpenPositions() {
    return Object.keys(this.openPositions).length > 0;
  }

  syncPositionValuationLoop() {
    if (this.positionValuationTimer) {
      clearInterval(this.positionValuationTimer);
      this.positionValuationTimer = null;
    }
    if (!this.hasOpenPositions()) return;
    this.positionValuationTimer = setInterval(() => {
      if (this.botShouldStop || !this.hasOpenPositions()) {
        this.syncPositionValuationLoop();
        return;
      }
      this.publishPortfolioUpdate().catch(() => {});
    }, this.config.positionValuationMs);
  }

  async publishPortfolioUpdate() {
    const positions = Object.values(this.openPositions);
    const marks = await Promise.allSettled(
      positions.map(async (position) => {
        const buffered = this.priceBuffers.latest(position.market.conditionId);
        if (Number.isFinite(buffered)) return buffered;
        return getMidpoint(position.market.tokenIdYes);
      })
    );
    const rows = positions.map((position, i) => {
      const result = marks[i];
      if (result.status === 'fulfilled' && Number.isFinite(result.value)) {
        position.lastMarkPrice = result.value;
        position.lastMarkAt = Date.now();
        return buildOpenPositionRow(position, result.value);
      }
      const fallback = Number.isFinite(position.lastMarkPrice)
        ? position.lastMarkPrice
        : position.entryPrice;
      return buildOpenPositionRow(position, fallback);
    });
    const totals = summarizeOpenPositions(rows);
    const metrics = computePortfolioMetrics({
      cash: this.cash,
      startingCash: this.startingCash,
      ...totals,
    });
    publishPortfolioSnapshot({
      mode: this.paperTrade ? 'paper' : 'live',
      ...metrics,
      realizedPnlTotal: this.realizedPnlTotal,
      openPositions: rows,
      strategyId: this.strategyId,
    });
  }

  async publishBotStatus(extra = {}) {
    if (!this.natsBridge) return;
    const { SUBJECTS } = require('../lib/nats/subjects');
    const { botStatus } = require('../lib/nats/schemas');
    await this.natsBridge.publish(
      SUBJECTS.BOT_STATUS,
      botStatus({
        running: !this.botShouldStop,
        mode: this.paperTrade ? 'paper' : 'live',
        strategyId: this.strategyId,
        cash: this.cash,
        portfolio: computePortfolioMetrics({
          cash: this.cash,
          startingCash: this.startingCash,
          ...summarizeOpenPositions(Object.values(this.openPositions)),
        }).portfolio,
        ...extra,
      })
    ).catch(() => {});
  }

  requestBotStop(reason) {
    if (this.botShouldStop) return;
    this.botShouldStop = true;
    this.botStopReason = reason;
    console.log(`[Bot] Session limit reached (${reason}) — no new entries; managing open positions then exit`);
    this.publishBotStatus({ stopReason: reason }).catch(() => {});
  }

  checkSessionLimits() {
    const { stop, reason } = this.session.shouldStopNewEntries(this.sessionState, {
      realizedPnlTotal: this.realizedPnlTotal,
    });
    if (stop) this.requestBotStop(reason);
  }

  shouldLogEntryCheck(marketId, signature) {
    const prev = this.entryCheckLogCache.get(marketId);
    if (prev === signature) return false;
    this.entryCheckLogCache.set(marketId, signature);
    return true;
  }

  logEntrySkip(market, reason, cacheKey = null) {
    const key = cacheKey || `${market.conditionId}:skip`;
    const sig = String(reason);
    if (!this.shouldLogEntryCheck(key, sig)) return;
    const line = `[Skip] ${formatWindowLabel(market.windowMinutes)} ${marketLabel(market)} | ${reason}`;
    console.log(`[EntrySkip] ${formatWindowLabel(market.windowMinutes)} ${marketLabel(market)} | ${reason}`);
    try {
      const { publishDashboardEvent } = require('../dashboard/hub');
      publishDashboardEvent({
        type: 'entry_skip',
        logLine: line,
        detail: reason,
        marketId: market.conditionId,
        windowMinutes: market.windowMinutes,
        timestamp: Date.now(),
      });
    } catch (_) {}
  }

  maybeExitWhenStopped() {
    if (!this.botShouldStop || this.hasOpenPositions()) return;
    console.log(`[Bot] Stopped (${this.botStopReason || 'requested'})`);
    setTimeout(() => process.exit(0), 250);
  }

  appendBtcPrice(price, ts = Date.now()) {
    this.priceBuffers.append(BTC_BUFFER_KEY, price, ts);
  }

  getBtcPriceHistory() {
    const series = this.priceBuffers.getNumericSeries(BTC_BUFFER_KEY);
    return series.length ? series : [];
  }

  startDirectBinanceFeed() {
    connectBinanceFeed((price, timing) => {
      this.appendBtcPrice(price, timing?.sourceTs || Date.now());
    });
  }

  async startNatsFeeds() {
    try {
      const { createNatsBridge } = require('../lib/natsBridge');
      const { SUBJECTS } = require('../lib/nats/subjects');
      this.natsBridge = this.natsBridge || createNatsBridge({ name: 'bot-feeds' });
      await this.natsBridge.connect();
      await this.natsBridge.subscribe(SUBJECTS.FEEDS_BINANCE_PRICE, (msg) => {
        const price = Number(msg?.price);
        if (!Number.isFinite(price)) return;
        this.appendBtcPrice(price, msg?.sourceTs || Date.now());
      });
      console.log('[Bot] Binance price via NATS');
      return true;
    } catch (e) {
      console.warn('[Bot] NATS feeds unavailable —', e.message);
      if (this.natsBridge) {
        await this.natsBridge.close().catch(() => {});
        this.natsBridge = null;
      }
      return false;
    }
  }

  async startNatsBot() {
    try {
      const { createNatsBridge } = require('../lib/natsBridge');
      const { SUBJECTS } = require('../lib/nats/subjects');
      this.natsBridge = this.natsBridge || createNatsBridge({ name: 'bot' });
      await this.natsBridge.connect();
      await this.natsBridge.subscribe(SUBJECTS.BOT_CONTROL, async (msg) => {
        const cmd = msg?.command;
        if (cmd === 'stop') {
          this.botShouldStop = true;
          console.log('[Bot] stop requested via NATS');
          setTimeout(() => process.exit(0), 250);
        }
        if (cmd === 'strategy' && msg?.strategyId) {
          console.log(`[Bot] strategy change requested (${msg.strategyId}) — restart bot to apply`);
        }
        if (cmd === 'window' && msg?.mode) {
          console.log(`[Bot] window mode requested (${msg.mode}) — feed publisher handles ingest`);
        }
      }, { dedup: false });
      await this.publishBotStatus({ startedAt: Date.now() });
    } catch (e) {
      console.warn('[Bot] NATS control unavailable — continuing without NATS:', e.message);
      if (this.natsBridge) {
        await this.natsBridge.close().catch(() => {});
        this.natsBridge = null;
      }
    }
  }

  /**
   * Apply dashboard/file cash adjustments via net delta (avoids double-apply).
   * @returns {boolean} whether cash or baseline changed
   */
  syncCashAdjustments() {
    const state = loadCashAdjustmentState();
    const targetNet = state.netCashDelta || 0;
    const diff = Math.round((targetNet - (this.syncedNetCashDelta || 0)) * 100) / 100;
    if (Math.abs(diff) < 1e-9) {
      const baseline = state.startingCashBaseline ?? this.envStartingCash;
      if (Math.abs(baseline - this.startingCash) > 1e-6) {
        this.startingCash = baseline;
        return true;
      }
      return false;
    }
    if (diff < 0 && this.cash + diff < -1e-6) {
      console.warn(`[Bot] Skipping cash withdrawal $${Math.abs(diff).toFixed(2)} — only $${this.cash.toFixed(2)} liquid`);
      return false;
    }
    this.cash = Math.max(0, this.cash + diff);
    this.syncedNetCashDelta = targetNet;
    this.startingCash = state.startingCashBaseline ?? this.envStartingCash;
    console.log(`[Bot] Cash adjustment ${diff >= 0 ? '+' : ''}$${diff.toFixed(2)} → cash=$${this.cash.toFixed(2)}`);
    return true;
  }

  async tick() {
    if (this.syncCashAdjustments()) {
      await this.publishPortfolioUpdate().catch(() => {});
    }
    this.checkSessionLimits();
    if (this.botShouldStop && !this.hasOpenPositions()) {
      this.maybeExitWhenStopped();
      return;
    }
    await this.publishBotStatus({
      tradesEntered: this.sessionState.tradesEntered,
      runLimit: this.sessionState.runLimit.mode,
      stopReason: this.botStopReason,
    });
    await this.publishPortfolioUpdate();

    if (this.cash <= 0 && !this.hasOpenPositions()) {
      console.log('[Bot] Cash depleted — cannot enter new trades');
      return;
    }

    const cycleStart = new Date();
    const openMetrics = summarizeOpenPositions(Object.values(this.openPositions));
    const cyclePortfolio = this.cash + (openMetrics.openPositionValue || 0);
    console.log(`\n[Cycle] ${cycleStart.toISOString()} | cash=$${this.cash.toFixed(2)} | portfolio=$${cyclePortfolio.toFixed(2)} | openPositions=${Object.keys(this.openPositions).length}`);

    let markets;
    try {
      markets = await this.scanner.fetchActiveMarkets();
    } catch (e) {
      console.error('[Bot] Failed to fetch markets:', e.message);
      return;
    }

    const openCount = Object.keys(this.openPositions).length;
    const resolutionLimit = Math.max(25, openCount * 3);
    try {
      this.recentResolutions = await this.scanner.fetchRecentResolutions(resolutionLimit);
    } catch (e) {
      console.warn('[Cycle] Failed to refresh resolved markets; continuing with last known values');
    }
    const resolvedMap = new Map(
      this.recentResolutions.map((m) => [m.conditionId, m.outcome])
    );
    await this.refreshResolutionOutcomesForOpenPositions(resolvedMap);
    this.resolutionByConditionId = resolvedMap;

    this.cachedMarkets = markets;
    this.rebuildTokenIndex(markets);

    await Promise.allSettled(
      Object.values(this.openPositions).map((position) => {
        const maybeActive = markets.find((m) => m.conditionId === position.market.conditionId);
        return this.checkExit(
          maybeActive || position.market,
          position,
          resolvedMap.get(position.market.conditionId) || null
        );
      })
    );

    if (!markets.length) {
      console.log('[Cycle] No BTC 5m/15m/1d markets available — waiting for next window');
      return;
    }

    const marketKey = markets.map((m) => m.conditionId).sort().join('|');
    if (marketKey !== this.lastActiveMarketKey) {
      console.log(`[Cycle] Live market roster updated (${markets.length} active window(s))`);
      markets.forEach((market, idx) => {
        const secs = Math.max(0, Math.round((market.endTime - Date.now()) / 1000));
        console.log(
          `[Cycle]  ${idx + 1}. ${formatWindowLabel(market.windowMinutes)} | ${marketLabel(market)} | tte=${secs}s | ${market.question}`
        );
      });
      this.lastActiveMarketKey = marketKey;
    }

    const tradableMarkets = this.botShouldStop
      ? []
      : markets.filter((m) => this.config.allowedWindows.includes(m.windowMinutes));

    if (this.config.useWsEval) {
      this.resyncClobWs(markets);
      if (tradableMarkets.length) {
        const watchlist = buildWatchlist(markets, this.openPositions, this.config.allowedWindows);
        await Promise.allSettled(watchlist.map((market) => this.evaluateMarket(market)));
      }
    } else if (tradableMarkets.length) {
      await Promise.allSettled(tradableMarkets.map((market) => this.evaluateMarket(market)));
    }

    this.maybeExitWhenStopped();

    if (this.hasOpenPositions()) {
      await this.publishPortfolioUpdate();
    }
  }

  async refreshResolutionOutcomesForOpenPositions(resolvedMap) {
    const tasks = Object.entries(this.openPositions).map(async ([cid, position]) => {
      if (resolvedMap.get(cid) === 'Yes' || resolvedMap.get(cid) === 'No') return;
      const market = position.market || {};
      if (!isMarketPastEnd(market)) return;
      try {
        const detail = await getMarketResolution(cid, {
          question: position.market?.question,
          slug: position.market?.slug,
        });
        if (detail?.outcome === 'Yes' || detail?.outcome === 'No') {
          resolvedMap.set(cid, detail.outcome);
        }
        if (detail?.endTime && position.market && !Number.isFinite(position.market.endTime)) {
          position.market.endTime = detail.endTime;
        }
      } catch (_) {}
    });
    await Promise.allSettled(tasks);
  }

  rebuildTokenIndex(markets) {
    this.marketByToken.clear();
    for (const m of markets || []) {
      if (m.tokenIdYes) this.marketByToken.set(m.tokenIdYes, m);
      if (m.tokenIdNo) this.marketByToken.set(m.tokenIdNo, m);
    }
  }

  collectWsAssetIds(markets) {
    const watchlist = buildWatchlist(markets, this.openPositions, this.config.allowedWindows);
    const ids = new Set();
    for (const m of watchlist) {
      if (m.tokenIdYes) ids.add(m.tokenIdYes);
      if (m.tokenIdNo) ids.add(m.tokenIdNo);
    }
    for (const pos of Object.values(this.openPositions)) {
      const tid = pos.tokenIdYes || pos.market?.tokenIdYes;
      if (tid) ids.add(tid);
    }
    return [...ids].sort();
  }

  resyncClobWs(markets) {
    const assetIds = this.collectWsAssetIds(markets);
    const key = assetIds.join(',');
    if (key === this.clobWsAssetKey) return;
    if (this.clobWsHandle) {
      this.clobWsHandle.close();
      this.clobWsHandle = null;
    }
    this.clobWsAssetKey = key;
    if (!assetIds.length) return;

    this.clobWsHandle = subscribeClobAssets(
      assetIds,
      (assetId, price, eventType, timing) => this.onClobPrice(assetId, price, eventType, timing),
      (err) => console.warn('[Bot WS]', err?.message || err)
    );
    console.log(`[Bot WS] subscribed ${assetIds.length} token(s) on watchlist`);
  }

  onClobPrice(assetId, price, eventType, timing) {
    const market = this.marketByToken.get(assetId);
    if (!market || !Number.isFinite(price)) return;
    if (assetId === market.tokenIdYes) {
      const sourceTs = timing?.sourceTs || Date.now();
      this.priceBuffers.append(market.conditionId, price, sourceTs);
      if (timing?.sourceTs) {
        recordStreamLatency('poly_ws_price', {
          sourceTs: timing.sourceTs,
          receivedTs: timing.receivedAt || Date.now(),
          meta: { eventType, marketId: market.conditionId.slice(0, 12) },
        });
      }
      if (this.openPositions[market.conditionId]) {
        this.scheduleWsExitCheck(market);
      } else if (!this.botShouldStop) {
        this.scheduleWsEval(market);
      }
    }
  }

  scheduleWsEval(market) {
    const id = market.conditionId;
    const prev = this.wsEvalTimers.get(id);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.wsEvalTimers.delete(id);
      this.evaluateMarket(market, { fromWs: true }).catch(() => {});
    }, this.config.wsEvalThrottleMs);
    this.wsEvalTimers.set(id, timer);
  }

  scheduleWsExitCheck(market) {
    const id = market.conditionId;
    const prev = this.wsExitTimers.get(id);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.wsExitTimers.delete(id);
      const position = this.openPositions[id];
      if (!position) return;
      const resolvedOutcome = this.resolutionByConditionId.get(id) || null;
      this.checkExit(market, position, resolvedOutcome).catch(() => {});
    }, this.config.wsEvalThrottleMs);
    this.wsExitTimers.set(id, timer);
  }

  async evaluateMarket(market, opts = {}) {
    if (this.botShouldStop) {
      this.logEntrySkip(market, 'bot stopped (session limit or SIGTERM)', `${market.conditionId}:stopped`);
      return;
    }
    if (!this.config.allowedWindows.includes(market.windowMinutes)) {
      this.logEntrySkip(
        market,
        `window ${formatWindowLabel(market.windowMinutes)} not in allowed [${this.config.allowedWindows.map(formatWindowLabel).join(', ')}]`,
        `${market.conditionId}:window`
      );
      return;
    }

    const now = Date.now();
    const timeRemaining = Math.max(0, (market.endTime - now) / 1000);

    if (!isWithinTradingWindow(market, timeRemaining, this.entryRules)) {
      this.logEntrySkip(
        market,
        `timeRemaining ${Math.round(timeRemaining)}s outside entry window (${formatWindowLabel(market.windowMinutes)})`,
        `${market.conditionId}:tte`
      );
      return;
    }

    const tradesInMarket = this.marketTradeCounts.get(market.conditionId) || 0;
    if (tradesInMarket >= this.config.maxTradesPerMarket) {
      this.logEntrySkip(
        market,
        `max ${this.config.maxTradesPerMarket} trade(s) per market already used (${tradesInMarket})`,
        `${market.conditionId}:max_trades`
      );
      return;
    }

    if (this.openPositions[market.conditionId]) {
      const resolvedOutcome = this.resolutionByConditionId.get(market.conditionId) || null;
      await this.checkExit(market, this.openPositions[market.conditionId], resolvedOutcome);
      return;
    }

    try {
      const watchlist = buildWatchlist(
        this.cachedMarkets.length ? this.cachedMarkets : [market],
        this.openPositions,
        this.config.allowedWindows
      );
      const inWatchlist = watchlist.some((m) => m.conditionId === market.conditionId);
      const cachedYes = opts.fromWs ? this.priceBuffers.latest(market.conditionId) : null;
      const scan = await this.scanner.enrichForStrategy(market, {
        fetchOrderbook: inWatchlist,
        cachedYesPrice: cachedYes,
      });
      const { yesPrice, liquidityDepth, book, enriched } = scan;
      const activePreset = getActivePreset();
      const sizingConfig = resolveSizingConfig(activePreset);

      const routeResult = this.router.evaluate({
        market,
        yesPrice,
        liquidityDepth,
        cash: this.cash,
        btcPriceHistory: this.getBtcPriceHistory(),
        enriched,
      });
      const { strategy, decision, strategyId: chosenStrategyId } = routeResult;
      this.strategyId = chosenStrategyId;

      const entryEligible = Boolean(decision?.entryEligible);
      const strategyStop = Number.isFinite(decision?.stop) ? decision.stop : strategy.stop;
      const previewSizing = previewBetSize(this.cash, sizingConfig, {
        entry: yesPrice,
        stop: strategyStop,
        liquidityDepth,
        bayesianTracker: this.bayesianTracker,
      });
      const betSizePreview = previewSizing.betSize;
      const microstructure = computeAllMarketParams(book, {
        marketMeta: market,
        betSizeUsdc: betSizePreview,
        thresholds: activePreset,
        edgeCents: decision?.edgeCents,
      });
      const { params: marketParams, gate: paramGate } = microstructure;

      const entrySig = [
        entryEligible ? 'Y' : 'N',
        fmtPrice(yesPrice),
        Number.isFinite(marketParams.bidAskSpreadCents) ? marketParams.bidAskSpreadCents.toFixed(1) : 'n/a',
        Number.isFinite(marketParams.weakerSideUsd) ? marketParams.weakerSideUsd.toFixed(0) : 'n/a',
        decision?.reason || '',
        paramGate.shouldSkip ? 'skip' : 'ok',
        chosenStrategyId,
      ].join('|');
      const logEntryCheck = this.shouldLogEntryCheck(market.conditionId, entrySig);
      if (logEntryCheck) {
        console.log(
          `[EntryCheck] ${formatWindowLabel(market.windowMinutes)} ${marketLabel(market)} | strategy=${chosenStrategyId} | yes=${fmtPrice(yesPrice)} | spread=${Number.isFinite(enriched.spreadCents) ? `${enriched.spreadCents.toFixed(1)}¢` : Number.isFinite(marketParams.bidAskSpreadCents) ? `${marketParams.bidAskSpreadCents.toFixed(1)}¢` : 'n/a'} | depth=$${Number.isFinite(marketParams.weakerSideUsd) ? marketParams.weakerSideUsd.toFixed(0) : 'n/a'} | met=${entryEligible ? 'YES' : 'NO'}`
        );
      }
      if (logEntryCheck) {
        try {
          const { publishDashboardEvent } = require('../dashboard/hub');
          publishDashboardEvent({
            type: 'entry_check',
            detail: `${formatWindowLabel(market.windowMinutes)} ${marketLabel(market)} ${decision?.reason || ''} met=${entryEligible ? 'YES' : 'NO'}`,
            yesPrice,
            marketId: market.conditionId,
            strategyId: chosenStrategyId,
            timestamp: Date.now(),
          });
          publishDashboardEvent({
            type: 'params',
            source: 'lab',
            market: {
              conditionId: market.conditionId,
              question: market.question,
              windowMinutes: market.windowMinutes,
            },
            params: marketParams,
            gate: paramGate,
            preset: {
              id: activePreset.id,
              name: activePreset.name,
              sizingMode: sizingConfig.sizingMode,
              fixedBetUsd: sizingConfig.fixedBetUsd,
            },
          });
        } catch (_) {}
      }
      if (!entryEligible) {
        this.logEntrySkip(
          market,
          `strategy not met: ${decision?.reason || 'entryEligible=false'} (yes=${fmtPrice(yesPrice)})`,
          `${market.conditionId}:strategy`
        );
        return;
      }

      if (!passesEntryPriceBand(yesPrice, this.entryRules)) {
        this.logEntrySkip(
          market,
          `YES ${fmtPrice(yesPrice)} outside entry price band`,
          `${market.conditionId}:price_band`
        );
        return;
      }

      if (paramGate.shouldSkip) {
        this.logEntrySkip(
          market,
          `microstructure gate (${paramGate.gateMode}): ${paramGate.blocks.join('; ')}`
        );
        return;
      }
      if (paramGate.warnings.length && logEntryCheck) {
        console.log(
          `[EntryCheck] ${marketLabel(market)} | microstructure warnings: ${paramGate.warnings.join('; ')}`
        );
      }

      await this.executeEntry({
        market,
        timeRemaining,
        strategy,
        decision,
        strategyStop,
        sizingConfig,
        activePreset,
        chosenStrategyId,
      });
    } catch (e) {
      console.error(`[Bot] Error checking market ${market.conditionId}:`, e.message);
    }
  }

  async executeEntry({
    market,
    timeRemaining,
    strategy,
    decision,
    strategyStop,
    sizingConfig,
    activePreset,
    chosenStrategyId,
  }) {
    const decidedAt = Date.now();
    const depthFetchStart = decidedAt;
    const { yesPrice, liquidityDepth } = await this.scanner.refreshEntryQuotes(market);
    const depthFetchEnd = Date.now();
    const depthSetAt = depthFetchEnd;

    const exitMode = this.config.exitMode;
    const exitTargetPrice = this.config.exitTargetPrice;
    const signal = {
      edgeCase: decision?.edgeCase || strategy.id,
      tier: decision?.tier || 1,
      direction: 'YES',
      entry: yesPrice,
      target: exitMode === 'fixed_price' && Number.isFinite(exitTargetPrice)
        ? exitTargetPrice
        : 1.0,
      stop: resolveStopThreshold(yesPrice, this.stopProfile, strategyStop),
      holdToResolution: exitMode === 'resolve_only',
      reason: decision?.reason || strategy.description || 'Strategy entry',
    };

    const sizingResult = computePositionBetSize(this.cash, sizingConfig, {
      signal,
      liquidityDepth,
      bayesianTracker: this.bayesianTracker,
      edgeCase: signal.edgeCase,
    });
    const betSize = sizingResult.betSize;
    if (betSize <= 0) {
      const reason = sizingResult.reason === 'hard_floor'
        ? `cash $${this.cash.toFixed(2)} below hard floor`
        : sizingConfig.sizingMode === 'kelly' && liquidityDepth < 500
          ? `kelly sizing blocked (depth $${liquidityDepth.toFixed(0)} < $500 min)`
          : `sizing=${sizingConfig.sizingMode} returned $0`;
      this.logEntrySkip(market, reason, `${market.conditionId}:sizing`);
      return;
    }
    if (betSize > this.cash) {
      this.logEntrySkip(
        market,
        `insufficient cash $${this.cash.toFixed(2)} < bet $${betSize.toFixed(2)}`,
        `${market.conditionId}:cash`
      );
      return;
    }
    const cashBefore = this.cash;
    this.cash = Math.max(0, this.cash - betSize);
    const cashAfter = this.cash;
    const shares = calcShares(betSize, yesPrice);
    const windowLabel = formatMarketWindowLabel(market);

    const winRateLog = Number.isFinite(sizingResult.winRate)
      ? ` | winRate=${(sizingResult.winRate * 100).toFixed(1)}%`
      : '';
    const exitNote = exitMode === 'fixed_price' && Number.isFinite(exitTargetPrice)
      ? ` | exit=take_profit@${exitTargetPrice.toFixed(2)}`
      : ' | exit=resolve_only';
    console.log(
      `[PositionOpen] ${marketLabel(market)} | sizing=${sizingConfig.sizingMode} | size=$${betSize.toFixed(2)} | shares=${shares.toFixed(2)} YES | entry=${fmtPrice(yesPrice)} | stop=${signal.stop.toFixed(3)}${exitNote} | depth=${liquidityDepth.toFixed(0)} | depthFetch=${depthFetchEnd - depthFetchStart}ms${winRateLog}`
    );

    const tradeId = `${this.paperTrade ? 'paper' : 'live'}-${market.conditionId}-${++this.liveTradeSeq}`;
    this.openPositions[market.conditionId] = {
      tradeId,
      signal,
      entryPrice: yesPrice,
      betSize,
      shares,
      costBasis: betSize,
      entryTime: depthSetAt,
      market,
      timeRemainingAtEntry: Math.round(timeRemaining),
      orderbookDepthAtEntry: liquidityDepth,
      cashBefore,
      strategyId: chosenStrategyId,
      exitMode,
      exitTargetPrice: exitMode === 'fixed_price' ? exitTargetPrice : null,
      tokenIdYes: market.tokenIdYes,
    };

    const latencyTiming = recordTradeDepthPipeline({
      tradeId,
      marketId: market.conditionId,
      decidedAt,
      depthFetchStart,
      depthFetchEnd,
      depthSetAt,
      orderbookDepthAtEntry: liquidityDepth,
    });

    watchPostEntryDepth({
      tradeId,
      tokenId: market.tokenIdYes,
      depthAtEntry: liquidityDepth,
      entryAt: depthSetAt,
    });

    this.session.recordTradeEntered(this.sessionState);
    this.marketTradeCounts.set(
      market.conditionId,
      (this.marketTradeCounts.get(market.conditionId) || 0) + 1
    );
    this.entryCheckLogCache.delete(market.conditionId);
    this.entryCheckLogCache.delete(`${market.conditionId}:sizing`);
    if (isTradeLimitReached(this.sessionState)) {
      this.requestBotStop('trade_limit');
    }
    this.checkSessionLimits();

    this.syncPositionValuationLoop();
    await this.publishPortfolioUpdate();
    emitTradeEvent({
      eventType: 'entry',
      tradeId,
      mode: this.paperTrade ? 'paper' : 'live',
      marketId: market.conditionId,
      question: market.question,
      windowMinutes: market.windowMinutes,
      windowLabel,
      edgeCase: signal.edgeCase,
      tier: signal.tier,
      direction: signal.direction,
      entryTime: depthSetAt,
      timeRemainingAtEntry: Math.round(timeRemaining),
      entryPrice: signal.entry,
      target: signal.target,
      stop: signal.stop,
      betSize,
      shares,
      costBasis: betSize,
      orderbookDepth: liquidityDepth,
      signalReason: signal.reason,
      strategyId: chosenStrategyId,
      cashBefore,
      cashAfter,
      latencyTiming,
    });
  }

  async checkExit(market, position, resolvedOutcome = null) {
    const { signal, entryPrice, betSize, shares: storedShares } = position;
    const shares = storedShares ?? calcShares(betSize, entryPrice);
    const now = Date.now();
    const tokenId = position.tokenIdYes || market.tokenIdYes;
    const exitMode = position.exitMode || this.config.exitMode || 'resolve_only';
    const exitTargetPrice = Number.isFinite(position.exitTargetPrice)
      ? position.exitTargetPrice
      : this.config.exitTargetPrice;

    try {
      const buffered = this.priceBuffers.latest(market.conditionId);
      const currentPrice = Number.isFinite(buffered)
        ? buffered
        : await getMidpoint(tokenId);
      position.lastMarkPrice = currentPrice;
      position.lastMarkAt = Date.now();
      const unrealizedPnl = calcRealizedPnl(shares, entryPrice, currentPrice, betSize);
      const targetHint = exitMode === 'fixed_price' && Number.isFinite(exitTargetPrice)
        ? ` | tp@${exitTargetPrice.toFixed(2)}`
        : ' | hold→resolve';
      console.log(
        `[Position] ${marketLabel(market)} | yes=${fmtPrice(currentPrice)} | entry=${fmtPrice(entryPrice)} | shares=${shares.toFixed(2)} | unrealized=$${unrealizedPnl.toFixed(2)}${targetHint}`
      );

      const stopThreshold = resolveStopThreshold(entryPrice, this.stopProfile, signal?.stop);
      const stopActive = Number.isFinite(stopThreshold) && stopThreshold > 0;
      const exitByStop = stopActive && currentPrice <= stopThreshold;
      const exitByTakeProfit = exitMode === 'fixed_price'
        && Number.isFinite(exitTargetPrice)
        && currentPrice >= exitTargetPrice;
      const settlementOutcome = resolveSettlementOutcome({
        gammaOutcome: resolvedOutcome,
        yesPrice: currentPrice,
        market,
        requireExpired: true,
      });
      const exitByResolution = settlementOutcome === 'Yes' || settlementOutcome === 'No';

      if (!exitByStop && !exitByTakeProfit && !exitByResolution) return;

      let exitPrice = currentPrice;
      let exitReason = 'resolution';
      if (exitByStop) {
        exitPrice = Math.min(currentPrice, stopThreshold);
        exitReason = 'stop_loss';
      } else if (exitByTakeProfit) {
        exitPrice = currentPrice;
        exitReason = 'take_profit';
      } else if (exitByResolution) {
        const direction = signal?.direction || position.direction || 'YES';
        exitPrice = settlementExitPrice(settlementOutcome, direction);
        exitReason = 'resolution';
        resolvedOutcome = settlementOutcome;
      }

      const won = exitPrice > entryPrice;
      this.bayesianTracker.update(signal.edgeCase, won);
      const pnl = calcRealizedPnl(shares, entryPrice, exitPrice, betSize);
      const proceeds = calcExitProceeds(shares, exitPrice);
      const cashBefore = this.cash;

      if (Number.isFinite(proceeds)) {
        this.cash += proceeds;
      }
      this.realizedPnlTotal += pnl;
      const cashAfter = this.cash;

      delete this.openPositions[market.conditionId];
      this.syncPositionValuationLoop();

      const icon = won ? '✓' : '✗';
      console.log(
        `[ExitTrigger] ${marketLabel(market)} | reason=${exitReason} | stop@${stopThreshold.toFixed(2)} | resolved=${resolvedOutcome || 'n/a'}`
      );
      console.log(`[Exit ${icon}] ${signal.direction} | shares=${shares.toFixed(2)} | exit=${fmtPrice(exitPrice)} | pnl=$${pnl.toFixed(2)} | cash=$${this.cash.toFixed(2)}`);

      emitTradeEvent({
        eventType: 'exit',
        tradeId: position.tradeId,
        mode: this.paperTrade ? 'paper' : 'live',
        marketId: market.conditionId,
        question: market.question,
        windowMinutes: market.windowMinutes,
        windowLabel: formatMarketWindowLabel(market),
        edgeCase: signal.edgeCase,
        tier: signal.tier,
        direction: signal.direction,
        entryTime: position.entryTime,
        exitTime: now,
        holdSeconds: Math.round((now - position.entryTime) / 1000),
        timeRemainingAtEntry: position.timeRemainingAtEntry,
        entryPrice,
        exitPrice,
        target: signal.target,
        stop: signal.stop,
        betSize,
        shares,
        costBasis: betSize,
        orderbookDepth: position.orderbookDepthAtEntry,
        signalReason: signal.reason,
        exitReason,
        won,
        pnl,
        cashBefore,
        cashAfter,
        exitProceeds: proceeds,
      });
      this.syncPositionValuationLoop();
      await this.publishPortfolioUpdate();
      this.checkSessionLimits();
      this.maybeExitWhenStopped();
    } catch (e) {
      console.error('[Bot] Error checking exit:', e.message);
    }
  }
}

module.exports = { PolymarketBot };
