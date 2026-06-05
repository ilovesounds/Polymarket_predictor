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
const { sharedEngine: microstructureEngine } = require('../signals/microstructure');
const { computeBtcUpPrediction, buildBtcUpModelView, MIN_TRADES_60S } = require('../signals/btcUpModel');
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
  formatExitLog,
  formatEntryLog,
  settleAtResolution,
} = require('../paper/portfolio');
const { getMidpoint, subscribeClobAssets, getMarketResolution } = require('../api/polymarket_runtime');
const {
  resolveSettlementOutcome,
  isMarketPastEnd,
  isNearResolutionPrice,
} = require('../lib/marketResolution');
const { isTradeLimitReached, runStopMessage, buildRunProgressSnapshot } = require('../lib/botRunConfig');
const {
  resolveStopThreshold,
  passesEntryPriceBand,
  entryWindowPreview,
  stopLossPreview,
  elapsedAfterMarketStart,
  formatEntryWindowBand,
  WINDOW_TOTAL_SEC,
} = require('../lib/botProfile');
const { loadCashAdjustmentState } = require('../lib/cashAdjustments');
const { PriceBufferStore, BTC_BUFFER_KEY } = require('../lib/priceRingBuffer');
const { recordStreamLatency } = require('../monitoring/latency');
const { isWindowActive } = require('../lib/marketSelection');
const {
  listOpenPositions,
  openConditionIds,
  positionsForMarket,
  openCountForMarket,
  conditionIdFromPosition,
} = require('../lib/openPositions');
const { MarketScanner, buildEvalMarkets } = require('./MarketScanner');
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
    /** @type {Map<string, number>} */
    this.lastEntryTimeByMarket = new Map();
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

  /** True when Binance aggTrade ingestion is required for entry decisions. */
  needsMicrostructureFeed() {
    if (this.config.useMicrostructureModel) return true;
    return (this.config.strategyIds || []).some((id) => id === 'microstructure_edge');
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
    const sizingDetail = sizingCfg.sizingMode === 'fixed'
      ? ` ($${sizingCfg.fixedBetUsd})`
      : sizingCfg.sizingMode === 'percent' || sizingCfg.sizingMode === 'amount_cap'
        ? ` (${sizingCfg.betPercent}%)`
        : sizingCfg.sizingMode === 'kelly'
          ? ` (cap ${(sizingCfg.kellyFractionCap * 100).toFixed(0)}%)`
          : '';
    const profileTag = this.config.profileId ? ` | profile=${this.config.profileId}` : '';
    console.log(`  Sizing: ${sizingCfg.sizingMode}${sizingDetail}${profileTag}`);
    const exitLabel = this.config.exitMode === 'fixed_price'
      ? `fixed_price @ ${this.config.exitTargetPrice}`
      : 'resolve_only (hold to resolution)';
    const slParts = [];
    if (Number.isFinite(this.config.stopLossPct)) slParts.push(`${this.config.stopLossPct}%`);
    if (Number.isFinite(this.config.stopLossPrice)) slParts.push(`@${this.config.stopLossPrice}`);
    if (!slParts.length) slParts.push(`floor ${this.config.stopThreshold}`);
    const wm = this.config.allowedWindows[0] || 5;
    console.log(`  ${stopLossPreview(this.stopProfile, 0.5, this.router?.strategies?.[0]?.stop)}`);
    console.log(`  ${entryWindowPreview(this.entryRules, wm)} (per-window defaults if unset)`);
    console.log(`  Exit: ${exitLabel} | stop=${slParts.join(' ')} | ${this.reEntryModeLabel()}`);
    if (this.needsMicrostructureFeed()) {
      const feedPath = this.config.botUseNatsFeeds
        ? 'NATS price + direct aggTrade sidecar'
        : 'direct Binance aggTrade WS';
      console.log(
        `  Microstructure: ON | edge ≥ ${(this.config.edgeThreshold * 100).toFixed(0)}% | feed=${feedPath}`,
      );
    }
    console.log(`  Price path: ${this.config.useWsEval ? `CLOB WS (throttle ${this.config.wsEvalThrottleMs}ms) + ${this.config.pollIntervalMs / 1000}s discovery tick` : `REST poll ${this.config.pollIntervalMs / 1000}s`}`);
    console.log(`${'═'.repeat(50)}\n`);

    if (!this.config.privateKey) {
      console.warn('[Bot] No PRIVATE_KEY — running in paper trade mode');
    }

    if (this.config.botUseNatsFeeds) {
      const feedsOk = await this.startNatsFeeds();
      if (!feedsOk) {
        this.startDirectBinanceFeed();
      } else if (this.needsMicrostructureFeed()) {
        this.startMicrostructureAggTradeFeed();
      }
    } else {
      this.startDirectBinanceFeed();
    }

    if (this.config.useNats) {
      await this.startNatsBot();
    }

    if (this.config.chainlinkEnabled) {
      try {
        const provider = new ethers.JsonRpcProvider(this.config.polygonRpc);
        await provider.getNetwork();
        setInterval(() => pollChainlink(provider), 30_000);
        await pollChainlink(provider);
        console.log('[Setup] Chainlink feed connected');
      } catch (_) {
        console.warn('[Setup] Chainlink unavailable — using Binance for price to beat');
      }
    } else {
      console.log('[Setup] Chainlink optional — using Binance for price to beat');
    }

    this.recentResolutions = await this.scanner.fetchRecentResolutions(10);
    console.log('[Setup] Binance feed connected');
    console.log('[Setup] Ready to trade\n');
  }

  hasOpenPositions() {
    return listOpenPositions(this.openPositions).length > 0;
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

  reEntryModeLabel() {
    if (this.config.tradesPerMarket === 'multiple') {
      const cooldown = this.config.minSecondsBetweenEntries > 0
        ? `, ${this.config.minSecondsBetweenEntries}s cooldown`
        : '';
      const mode = this.config.multiEntryMode || 'sequential';
      if (mode === 'sequential') {
        return `re-entry: sequential (max ${this.config.maxTradesPerMarket} per window${cooldown})`;
      }
      return `re-entry: simultaneous (max ${this.config.maxTradesPerMarket} open${cooldown})`;
    }
    return 're-entry: one trade per market';
  }

  async publishPortfolioUpdate() {
    const positions = listOpenPositions(this.openPositions);
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

  async publishRunProgress() {
    const progress = buildRunProgressSnapshot(this.sessionState);
    try {
      const { publishDashboardEvent } = require('../dashboard/hub');
      publishDashboardEvent({
        type: 'run_progress',
        ...progress,
        running: !this.botShouldStop,
        stopReason: this.botStopReason,
      });
    } catch (_) {}
    await this.publishBotStatus({
      ...progress,
      tradesEntered: this.sessionState.tradesEntered,
      marketsTradedCount: this.sessionState.marketsTradedCount,
      runLimit: this.sessionState.runDuration?.runMode || this.sessionState.runLimit.mode,
      stopReason: this.botStopReason,
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
          ...summarizeOpenPositions(listOpenPositions(this.openPositions)),
        }).portfolio,
        ...extra,
      })
    ).catch(() => {});
  }

  requestBotStop(reason) {
    if (this.botShouldStop) return;
    this.botShouldStop = true;
    this.botStopReason = reason;
    const msg = runStopMessage(this.sessionState, reason);
    console.log(`[BotStop] ${msg} — no new entries; managing open positions then exit`);
    this.publishRunProgress().catch(() => {});
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
    this._emitEntrySkip(market, reason);
  }

  /** Always log — used when EntryCheck met=YES but execution blocked on the next gate. */
  logImmediateEntrySkip(market, reason) {
    this._emitEntrySkip(market, reason);
  }

  _emitEntrySkip(market, reason) {
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
    console.log(`[BotStop] Process exiting (${this.botStopReason || 'requested'})`);
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
      if (this.needsMicrostructureFeed() && timing?.trade) {
        microstructureEngine.ingestTrade(timing.trade);
      }
    });
    console.log('[Bot] Binance aggTrade feed connected (price + microstructure)');
  }

  /** Sidecar aggTrade WS when NATS supplies price-only ticks (no m/qty). */
  startMicrostructureAggTradeFeed() {
    connectBinanceFeed((_price, timing) => {
      if (timing?.trade) {
        microstructureEngine.ingestTrade(timing.trade);
      }
    });
    console.log('[Bot] Binance aggTrade sidecar for microstructure model (NATS price active)');
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
      console.warn(
        '[Bot] NATS control unavailable — continuing without NATS (HTTP dashboard control still works):',
        e.message,
        '— set NATS_URL=disabled and USE_NATS=false to silence'
      );
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
    await this.publishRunProgress();
    await this.publishPortfolioUpdate();

    if (this.cash <= 0 && !this.hasOpenPositions()) {
      console.log('[Bot] Cash depleted — cannot enter new trades');
      return;
    }

    const cycleStart = new Date();
    const markedRows = listOpenPositions(this.openPositions).map((position) => {
      const mark = this.priceBuffers.latest(position.market.conditionId)
        ?? position.lastMarkPrice
        ?? position.entryPrice;
      return buildOpenPositionRow(position, mark);
    });
    const openMetrics = summarizeOpenPositions(markedRows);
    const cyclePortfolio = this.cash + (openMetrics.openPositionValue || 0);
    console.log(`\n[Cycle] ${cycleStart.toISOString()} | cash=$${this.cash.toFixed(2)} | portfolio=$${cyclePortfolio.toFixed(2)} | openPositions=${listOpenPositions(this.openPositions).length}`);

    let markets;
    try {
      markets = await this.scanner.fetchActiveMarkets();
    } catch (e) {
      console.error('[Bot] Failed to fetch markets:', e.message);
      return;
    }

    const openCount = listOpenPositions(this.openPositions).length;
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
      listOpenPositions(this.openPositions).map((position) => {
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
        const secsRemaining = Math.max(0, Math.round((market.endTime - Date.now()) / 1000));
        const total = WINDOW_TOTAL_SEC[market.windowMinutes] || 300;
        const elapsed = Math.max(0, total - secsRemaining);
        console.log(
          `[Cycle]  ${idx + 1}. ${formatWindowLabel(market.windowMinutes)} | ${marketLabel(market)} | ${elapsed}s after start | ${market.question}`
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
        const evalMarkets = buildEvalMarkets(
          markets,
          this.openPositions,
          this.config.allowedWindows
        );
        await Promise.allSettled(evalMarkets.map((market) => this.evaluateMarket(market)));
      }
    } else if (tradableMarkets.length) {
      const evalMarkets = buildEvalMarkets(
        markets,
        this.openPositions,
        this.config.allowedWindows
      );
      await Promise.allSettled(evalMarkets.map((market) => this.evaluateMarket(market)));
    }

    this.maybeExitWhenStopped();

    if (this.hasOpenPositions()) {
      await this.publishPortfolioUpdate();
    }
  }

  async refreshResolutionOutcomesForOpenPositions(resolvedMap) {
    const tasks = listOpenPositions(this.openPositions).map(async (position) => {
      const cid = conditionIdFromPosition(position);
      if (!cid) return;
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
    const evalMarkets = buildEvalMarkets(
      markets,
      this.openPositions,
      this.config.allowedWindows
    );
    const ids = new Set();
    for (const m of evalMarkets) {
      if (m.tokenIdYes) ids.add(m.tokenIdYes);
      if (m.tokenIdNo) ids.add(m.tokenIdNo);
    }
    for (const pos of listOpenPositions(this.openPositions)) {
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
      if (openCountForMarket(this.openPositions, market.conditionId) > 0) {
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
      const positions = positionsForMarket(this.openPositions, id);
      if (!positions.length) return;
      const resolvedOutcome = this.resolutionByConditionId.get(id) || null;
      for (const position of positions) {
        this.checkExit(market, position, resolvedOutcome).catch(() => {});
      }
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

    const cid = market.conditionId;
    const openInMarket = positionsForMarket(this.openPositions, cid);
    for (const pos of openInMarket) {
      await this.checkExit(
        market,
        pos,
        this.resolutionByConditionId.get(cid) || null
      );
    }

    const openCount = openCountForMarket(this.openPositions, cid);
    if (this.config.tradesPerMarket === 'single') {
      if (openCount > 0) {
        this.logEntrySkip(
          market,
          'one trade per market — open position exists',
          `${cid}:single_open`
        );
        return;
      }
    } else {
      const maxTrades = this.config.maxTradesPerMarket;
      const entryMode = this.config.multiEntryMode || 'sequential';
      const entriesThisWindow = this.marketTradeCounts.get(cid) || 0;
      if (entryMode === 'sequential') {
        if (openCount > 0) {
          this.logEntrySkip(
            market,
            'sequential mode — wait until open position closes',
            `${cid}:sequential_open`
          );
          return;
        }
        if (entriesThisWindow >= maxTrades) {
          this.logEntrySkip(
            market,
            `max ${maxTrades} entries per window (${entriesThisWindow})`,
            `${cid}:max_entries`
          );
          return;
        }
      } else if (openCount >= maxTrades) {
        this.logEntrySkip(
          market,
          `max ${maxTrades} open position(s) per market (${openCount})`,
          `${cid}:max_open`
        );
        return;
      }
      const minGap = this.config.minSecondsBetweenEntries || 0;
      if (minGap > 0) {
        const lastEntry = this.lastEntryTimeByMarket.get(cid);
        if (lastEntry) {
          const elapsedSec = (Date.now() - lastEntry) / 1000;
          if (elapsedSec < minGap) {
            const remain = Math.ceil(minGap - elapsedSec);
            this.logEntrySkip(
              market,
              `re-entry cooldown — ${remain}s remaining`,
              `${cid}:cooldown`
            );
            return;
          }
        }
      }
    }

    try {
      const inEntryBand = isWithinTradingWindow(market, timeRemaining, this.entryRules);
      const fetchOrderbook = inEntryBand
        || isWindowActive(market, now)
        || openCountForMarket(this.openPositions, cid) > 0;
      const cachedYes = opts.fromWs ? this.priceBuffers.latest(market.conditionId) : null;
      const scan = await this.scanner.enrichForStrategy(market, {
        fetchOrderbook,
        cachedYesPrice: cachedYes,
      });
      const { yesPrice, liquidityDepth, book, enriched } = scan;
      const activePreset = getActivePreset();
      const sizingConfig = resolveSizingConfig(activePreset);

      let btcUpModel = null;
      if (this.needsMicrostructureFeed()) {
        const snap = microstructureEngine.getSnapshot();
        const pred = computeBtcUpPrediction(snap, {
          edgeThreshold: this.config.edgeThreshold,
        });
        btcUpModel = buildBtcUpModelView(pred, yesPrice);
        if (this.shouldLogEntryCheck(market.conditionId, `btcup|${btcUpModel.pUp}|${yesPrice}|${btcUpModel.edge}|${btcUpModel.ready}`)) {
          const pPct = (btcUpModel.pUp * 100).toFixed(0);
          const yPct = Number.isFinite(yesPrice) ? (yesPrice * 100).toFixed(0) : 'n/a';
          const edgeStr = Number.isFinite(btcUpModel.edgePct)
            ? `${btcUpModel.edgePct >= 0 ? '+' : ''}${btcUpModel.edgePct.toFixed(0)}`
            : 'n/a';
          const readyTag = btcUpModel.ready ? 'ready' : `cold (${btcUpModel.signals?.tradeCount60s ?? 0}/${MIN_TRADES_60S} trades)`;
          console.log(
            `[BtcUpModel] ${marketLabel(market)} | P(up)=${pPct}% | Poly YES=${yPct}% | edge=${edgeStr}% | ${readyTag}`,
          );
        }
      }

      const routeResult = this.router.evaluate({
        market,
        yesPrice,
        liquidityDepth,
        cash: this.cash,
        btcPriceHistory: this.getBtcPriceHistory(),
        enriched,
        btcUpModel,
        edgeThreshold: this.config.edgeThreshold,
      });
      const { strategy, decision, strategyId: chosenStrategyId } = routeResult;
      this.strategyId = chosenStrategyId;

      const entryEligible = Boolean(decision?.entryEligible);
      const rawStrategyStop = Number.isFinite(decision?.stop) ? decision.stop : strategy.stop;
      const strategyStop = resolveStopThreshold(yesPrice, this.stopProfile, rawStrategyStop);
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
        let skipDetail = decision?.reason || 'entryEligible=false';
        if (chosenStrategyId === 'microstructure_edge' && btcUpModel) {
          if (btcUpModel.coldStart) {
            skipDetail += ` | model cold start (${btcUpModel.signals?.tradeCount60s ?? 0}/${MIN_TRADES_60S} aggTrades in 60s — need Binance aggTrade feed)`;
          } else if (btcUpModel.ready && !btcUpModel.entrySignal) {
            skipDetail += ` | edge below threshold (need ≥${(this.config.edgeThreshold * 100).toFixed(0)}%)`;
          }
        }
        this.logEntrySkip(
          market,
          `strategy not met: ${skipDetail} (yes=${fmtPrice(yesPrice)})`,
          `${market.conditionId}:strategy`
        );
        return;
      }

      if (!inEntryBand) {
        const band = formatEntryWindowBand(market.windowMinutes, this.entryRules);
        const elapsed = elapsedAfterMarketStart(market.windowMinutes, timeRemaining);
        const skipReason = `outside entry window — need ${band} (currently ${elapsed}s after start)`;
        if (logEntryCheck) {
          this.logImmediateEntrySkip(market, skipReason);
        } else {
          this.logEntrySkip(market, skipReason, `${market.conditionId}:entry_window`);
        }
        return;
      }

      if (!passesEntryPriceBand(yesPrice, this.entryRules)) {
        const skipReason = `YES ${fmtPrice(yesPrice)} outside entry price band`;
        if (logEntryCheck) {
          this.logImmediateEntrySkip(market, skipReason);
        } else {
          this.logEntrySkip(market, skipReason, `${market.conditionId}:price_band`);
        }
        return;
      }

      if (paramGate.shouldSkip) {
        const skipReason = `microstructure gate (${paramGate.gateMode}): ${paramGate.blocks.join('; ')}`;
        if (logEntryCheck) {
          this.logImmediateEntrySkip(market, skipReason);
        } else {
          this.logEntrySkip(market, skipReason, `${market.conditionId}:gate`);
        }
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
      this.logImmediateEntrySkip(market, reason);
      return;
    }
    if (betSize > this.cash) {
      this.logImmediateEntrySkip(
        market,
        `insufficient cash $${this.cash.toFixed(2)} < bet $${betSize.toFixed(2)}`
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
    const profilePrefix = this.config.profileId ? `profile=${this.config.profileId} | ` : '';
    const sizingLabel = sizingConfig.sizingMode === 'percent' || sizingConfig.sizingMode === 'amount_cap'
      ? `${sizingConfig.sizingMode}(${sizingConfig.betPercent}%)`
      : sizingConfig.sizingMode;
    const exitNote = exitMode === 'fixed_price' && Number.isFinite(exitTargetPrice)
      ? ` | exit=take_profit@${exitTargetPrice.toFixed(2)}`
      : ' | exit=resolve_only';
    console.log(
      `[PositionOpen] ${profilePrefix}${marketLabel(market)} | sizing=${sizingLabel} | size=$${betSize.toFixed(2)} | shares=${shares.toFixed(2)} YES | entry=${fmtPrice(yesPrice)} | stop=${signal.stop.toFixed(3)}${exitNote} | depth=${liquidityDepth.toFixed(0)} | depthFetch=${depthFetchEnd - depthFetchStart}ms${winRateLog}`
    );

    const entryIndex = (this.marketTradeCounts.get(market.conditionId) || 0) + 1;
    const tradeId = `${this.paperTrade ? 'paper' : 'live'}-${market.conditionId}-${++this.liveTradeSeq}`;
    this.openPositions[tradeId] = {
      tradeId,
      entryIndex,
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
    this.marketTradeCounts.set(market.conditionId, entryIndex);
    this.lastEntryTimeByMarket.set(market.conditionId, depthSetAt);
    this.entryCheckLogCache.delete(market.conditionId);
    this.entryCheckLogCache.delete(`${market.conditionId}:sizing`);
    if (isTradeLimitReached(this.sessionState)) {
      this.requestBotStop('market_limit');
    }
    this.checkSessionLimits();

    this.syncPositionValuationLoop();
    await this.publishPortfolioUpdate();
    const entryLogLine = formatEntryLog({
      direction: signal.direction,
      shares,
      entryPrice: yesPrice,
      betSize,
      market,
      entryIndex,
    });
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
      entryIndex,
      logLine: entryLogLine,
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
      const stopThreshold = resolveStopThreshold(entryPrice, this.stopProfile, signal?.stop);
      const stopActive = Number.isFinite(stopThreshold) && stopThreshold > 0;
      const targetHint = exitMode === 'fixed_price' && Number.isFinite(exitTargetPrice)
        ? ` | tp@${exitTargetPrice.toFixed(2)}`
        : ' | hold→resolve';
      const stopHint = stopActive ? ` | stop@${stopThreshold.toFixed(2)}` : '';
      console.log(
        `[Position] ${marketLabel(market)} | yes=${fmtPrice(currentPrice)} | entry=${fmtPrice(entryPrice)} | shares=${shares.toFixed(2)} | unrealized=$${unrealizedPnl.toFixed(2)}${stopHint}${targetHint}`
      );
      const marketExpired = isMarketPastEnd(market);

      let settlementOutcome = resolveSettlementOutcome({
        gammaOutcome: resolvedOutcome,
        yesPrice: currentPrice,
        market,
        requireExpired: !isNearResolutionPrice(currentPrice),
      });
      if (!settlementOutcome && marketExpired) {
        try {
          const detail = await getMarketResolution(market.conditionId, {
            question: market.question || position.market?.question,
            slug: market.slug || position.market?.slug,
          });
          if (detail?.outcome === 'Yes' || detail?.outcome === 'No') {
            settlementOutcome = detail.outcome;
            this.resolutionByConditionId.set(market.conditionId, detail.outcome);
          }
        } catch (_) {}
      }
      const exitByResolution = settlementOutcome === 'Yes' || settlementOutcome === 'No';
      const exitByStop = !marketExpired && !exitByResolution && stopActive && currentPrice <= stopThreshold;
      const exitByTakeProfit = !marketExpired && !exitByResolution
        && exitMode === 'fixed_price'
        && Number.isFinite(exitTargetPrice)
        && currentPrice >= exitTargetPrice;

      if (!exitByStop && !exitByTakeProfit && !exitByResolution) return;

      const cashBefore = this.cash;
      let exitPrice = currentPrice;
      let exitReason = 'resolution';
      let pnl;
      let proceeds;
      let logLine;

      if (exitByResolution) {
        const settlement = settleAtResolution(position, settlementOutcome, {
          cash: this.cash,
          market,
          exitTime: now,
        });
        if (!settlement) return;

        exitPrice = settlement.exitEvent.exitPrice;
        pnl = settlement.exitEvent.pnl;
        proceeds = settlement.exitEvent.exitProceeds ?? settlement.proceeds;
        logLine = settlement.exitEvent.logLine;
        exitReason = 'resolution';
        resolvedOutcome = settlementOutcome;
        this.cash = settlement.cashAfter;
      } else {
        if (exitByStop) {
          exitPrice = Math.min(currentPrice, stopThreshold);
          exitReason = 'stop_loss';
        } else if (exitByTakeProfit) {
          exitPrice = currentPrice;
          exitReason = 'take_profit';
        }
        pnl = calcRealizedPnl(shares, entryPrice, exitPrice, betSize);
        proceeds = calcExitProceeds(shares, exitPrice);
        if (Number.isFinite(proceeds)) this.cash += proceeds;
        logLine = formatExitLog({
          direction: signal?.direction || 'YES',
          shares,
          exitPrice,
          pnl,
          market,
          exitReason,
        });
      }

      const won = exitPrice > entryPrice;
      this.bayesianTracker.update(signal.edgeCase, won);
      this.realizedPnlTotal += pnl;
      const cashAfter = this.cash;

      delete this.openPositions[position.tradeId];
      this.syncPositionValuationLoop();

      if (exitReason === 'resolution') {
        console.log(logLine);
      } else {
        const icon = won ? '✓' : '✗';
        console.log(
          `[ExitTrigger] ${marketLabel(market)} | reason=${exitReason} | stop@${stopThreshold.toFixed(2)} | resolved=${resolvedOutcome || 'n/a'}`
        );
        console.log(`[Exit ${icon}] ${signal.direction} | shares=${shares.toFixed(2)} | exit=${fmtPrice(exitPrice)} | pnl=$${pnl.toFixed(2)} | cash=$${this.cash.toFixed(2)}`);
      }

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
        resolvedOutcome: exitReason === 'resolution' ? resolvedOutcome : null,
        logLine,
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
