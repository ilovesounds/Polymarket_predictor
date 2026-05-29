(() => {
  const D = window.Dashboard;
  const S = window.SizingUi;
  const P = window.BotProfileUi;
  const MAX_LOG = 80;

  const botProfileSelect = document.getElementById('bot-profile-select');
  const botStrategySelect = document.getElementById('bot-strategy-select');
  const botStartBtn = document.getElementById('bot-start-btn');
  const botStopBtn = document.getElementById('bot-stop-btn');
  const botLog = document.getElementById('bot-log');
  const botSizingPreview = document.getElementById('bot-sizing-preview');
  const botFixedBetInput = document.getElementById('bot-fixed-bet-usd');
  const botBetPercentInput = document.getElementById('bot-bet-percent');
  const botBetPercentSlider = document.getElementById('bot-bet-percent-slider');
  const botKellyCapInput = document.getElementById('bot-kelly-cap');
  const botSizingPanels = {
    fixed: document.getElementById('bot-sizing-panel-fixed'),
    percent: document.getElementById('bot-sizing-panel-percent'),
    kelly: document.getElementById('bot-sizing-panel-kelly'),
  };
  const botProfileEls = {
    strategySelect: botStrategySelect,
    stopLossMode: document.getElementById('bot-stop-loss-mode'),
    stopLossValue: document.getElementById('bot-stop-loss-value'),
    stopLossSlider: document.getElementById('bot-stop-loss-slider'),
    stopLossValueLabel: document.getElementById('bot-stop-loss-value-label'),
    entryMinSeconds: document.getElementById('bot-entry-min-seconds'),
    entryMaxSeconds: document.getElementById('bot-entry-max-seconds'),
    takeProfitPrice: document.getElementById('bot-take-profit-price'),
    tradesPerMarket: document.getElementById('bot-trades-per-market'),
    maxTradesPerMarket: document.getElementById('bot-max-trades-market'),
    maxTradesPerMarketGroup: document.getElementById('bot-max-trades-group'),
    maxTradesPerMarketLabel: document.getElementById('bot-max-trades-label'),
    minSecondsBetweenEntries: document.getElementById('bot-min-entry-cooldown'),
    minSecondsBetweenEntriesGroup: document.getElementById('bot-entry-cooldown-group'),
    multiEntryModeGroup: document.getElementById('bot-multi-entry-mode-group'),
    multiEntryModeRadios: () => Array.from(document.querySelectorAll('input[name="bot-multi-entry-mode"]')),
    runModeRadios: () => Array.from(document.querySelectorAll('input[name="bot-run-mode"]')),
    runMarketLimit: document.getElementById('bot-run-market-limit'),
    runTimeLimit: document.getElementById('bot-run-time-limit'),
    runUntil: document.getElementById('bot-run-until'),
    runMarketGroup: document.getElementById('bot-run-market-group'),
    runTimeGroup: document.getElementById('bot-run-time-group'),
  };
  const botTradingPreview = document.getElementById('bot-trading-preview');
  const botRunStatus = document.getElementById('bot-run-status');

  let controlBusy = false;
  let activeProfileId = 'default';
  let cachedProfile = {};
  let namedProfiles = [];
  let runStatusTimer = null;

  function prependLog(el, html, cls) {
    if (!el) return;
    const line = document.createElement('div');
    line.className = `line ${cls || ''}`.trim();
    line.innerHTML = html;
    el.prepend(line);
    while (el.children.length > MAX_LOG) el.removeChild(el.lastChild);
  }

  function readSizingPayload() {
    return S.readSizingFromForm({
      fixedBetInput: botFixedBetInput,
      betPercentInput: botBetPercentInput,
      kellySlider: botKellyCapInput,
      name: 'bot-sizing-mode',
    });
  }

  function readTradingPayload() {
    if (!P) return {};
    const payload = P.readProfileFromForm(botProfileEls);
    if (botProfileEls.stopLossMode?.value === 'off') {
      payload.stopLossPct = null;
      payload.stopLossPrice = null;
    }
    return payload;
  }

  function profileWindowMinutes() {
    const mw = cachedProfile.marketWindow || '5m';
    if (mw === '15m') return 15;
    if (mw === '1d') return 1440;
    return 5;
  }

  function refreshTradingPreview() {
    if (!botTradingPreview || !P) return;
    botTradingPreview.textContent = P.formatTradingPreview(
      { ...cachedProfile, ...readTradingPayload() },
      profileWindowMinutes()
    );
  }

  function currentProfilePayload() {
    return {
      ...cachedProfile,
      strategyId: botStrategySelect?.value || cachedProfile.strategyId,
      ...readTradingPayload(),
      ...(P ? P.readRunDurationFromForm(botProfileEls) : {}),
      ...readSizingPayload(),
      id: activeProfileId,
    };
  }

  function renderRunStatus() {
    if (!botRunStatus) return;
    const bot = D.getState().bot;
    if (!bot.running) {
      botRunStatus.textContent = '';
      return;
    }
    const label = P?.formatRunProgressLabel(bot.runProgress);
    botRunStatus.textContent = label ? `Run progress: ${label}` : '';
  }

  function syncRunStatusTimer() {
    if (runStatusTimer) clearInterval(runStatusTimer);
    runStatusTimer = null;
    if (!D.getState().bot.running) {
      renderRunStatus();
      return;
    }
    renderRunStatus();
    runStatusTimer = setInterval(renderRunStatus, 15_000);
  }

  function refreshSizingPreview() {
    const bankroll = D.getPortfolio()?.cash;
    if (!Number.isFinite(bankroll) || !botSizingPreview) return;
    const mode = S.getSelectedMode('bot-sizing-mode');
    const pct = Number(botBetPercentInput?.value || 25);
    const fixed = Number(botFixedBetInput?.value || 5);
    let bet = bankroll;
    if (mode === 'percent') bet = Math.min(bankroll, bankroll * (pct / 100));
    else if (mode === 'fixed') bet = Math.min(fixed, bankroll);
    else if (mode === 'kelly') bet = Math.min(bankroll * 0.08, bankroll);
    S.renderPreview(botSizingPreview, {
      label: `Next bet ≈ $${bet.toFixed(2)} (${bankroll > 0 ? ((bet / bankroll) * 100).toFixed(1) : 0}% of $${bankroll.toFixed(2)})`,
    });
  }

  function applyNamedProfile(profile) {
    if (!profile) return;
    activeProfileId = profile.id;
    cachedProfile = { ...profile };
    if (botProfileSelect) botProfileSelect.value = profile.id;
    if (profile.strategyId && botStrategySelect) {
      botStrategySelect.value = profile.strategyId;
      D.getState().selectedStrategy = profile.strategyId;
    }
    if (P) P.applyProfileToForm(profile, botProfileEls);
    S.applySizingToForm(profile, {
      fixedBetInput: botFixedBetInput,
      betPercentInput: botBetPercentInput,
      kellySlider: botKellyCapInput,
      panels: botSizingPanels,
      name: 'bot-sizing-mode',
    });
    refreshSizingPreview();
    refreshTradingPreview();
  }

  function renderProfileSelect(profiles = [], selectedId) {
    if (!botProfileSelect) return;
    namedProfiles = profiles;
    botProfileSelect.innerHTML = profiles
      .map((p) => `<option value="${p.id}">${p.name} (${S.sizingLabel(p.sizingMode, p)})</option>`)
      .join('');
    if (selectedId) botProfileSelect.value = selectedId;
    activeProfileId = botProfileSelect.value || selectedId || 'default';
  }

  async function loadProfiles(selectId) {
    const resp = await fetch('/api/bot/profiles').then((r) => r.json());
    renderProfileSelect(resp.profiles || [], selectId || resp.activeProfileId);
    if (resp.activeProfile) applyNamedProfile(resp.activeProfile);
    if (resp.sizingPreview) S.renderPreview(botSizingPreview, resp.sizingPreview);
    return resp;
  }

  async function selectProfile(profileId) {
    const resp = await D.postJson('/api/bot/profiles', { id: profileId, select: true });
    if (resp.profile) applyNamedProfile(resp.profile);
    if (resp.sizingPreview) S.renderPreview(botSizingPreview, resp.sizingPreview);
    const portfolio = await fetch(`/api/portfolio?profileId=${encodeURIComponent(profileId)}`).then((r) => r.json());
    D.applyPortfolioSnapshot(portfolio);
    return resp;
  }

  function renderStrategies(strategies = [], current) {
    if (!botStrategySelect || !strategies.length) return;
    botStrategySelect.innerHTML = strategies
      .map((s) => `<option value="${s.id}">${s.label}</option>`)
      .join('');
    botStrategySelect.value = current || D.getState().selectedStrategy;
  }

  function setProfileControlsDisabled(disabled) {
    const fields = [
      botProfileSelect,
      botStrategySelect,
      botFixedBetInput,
      botBetPercentInput,
      botBetPercentSlider,
      botKellyCapInput,
      botProfileEls.stopLossMode,
      botProfileEls.stopLossValue,
      botProfileEls.stopLossSlider,
      botProfileEls.entryMinSeconds,
      botProfileEls.entryMaxSeconds,
      botProfileEls.takeProfitPrice,
      ...botProfileEls.runModeRadios(),
      botProfileEls.runMarketLimit,
      botProfileEls.runTimeLimit,
      botProfileEls.runUntil,
      ...S.getRadios('bot-sizing-mode'),
    ];
    for (const el of fields) {
      if (el) el.disabled = disabled;
    }
  }

  function renderBotControl() {
    const bot = D.getState().bot;
    const running = Boolean(bot.running);
    if (botStartBtn) botStartBtn.disabled = running || controlBusy;
    if (botStopBtn) botStopBtn.disabled = !running || controlBusy;
    setProfileControlsDisabled(controlBusy || running);
  }

  function setControlBusy(next) {
    controlBusy = next;
    renderBotControl();
  }

  async function saveBotProfile() {
    const payload = currentProfilePayload();
    await D.postJson('/api/bot/profiles', { ...payload, apply: true, select: true });
    const resp = await D.postJson('/api/bot/profile', payload);
    if (resp.profile) cachedProfile = { ...cachedProfile, ...resp.profile };
    await loadProfiles(activeProfileId);
    return resp;
  }

  async function startBot() {
    setControlBusy(true);
    try {
      await saveBotProfile();
      const resp = await D.postJson('/api/bot/start', { profileId: activeProfileId, ...currentProfilePayload() });
      if (resp.bot) {
        Object.assign(D.getState().bot, resp.bot);
        if (resp.bot.runProgress) D.getState().bot.runProgress = resp.bot.runProgress;
      }
      renderBotControl();
      syncRunStatusTimer();
      prependLog(botLog, `<strong>started</strong> profile ${activeProfileId}`, 'bot-entry');
    } catch (e) {
      prependLog(botLog, `<strong>start failed</strong> ${e.message}`, 'bot-exit');
    } finally {
      setControlBusy(false);
    }
  }

  async function stopBot() {
    setControlBusy(true);
    try {
      const resp = await D.postJson('/api/bot/stop');
      if (resp.bot) Object.assign(D.getState().bot, resp.bot);
      renderBotControl();
      syncRunStatusTimer();
    } catch (e) {
      prependLog(botLog, `<strong>stop failed</strong> ${e.message}`, 'bot-exit');
    } finally {
      setControlBusy(false);
    }
  }

  async function setStrategy(strategyId) {
    cachedProfile.strategyId = strategyId;
    if (D.getState().bot.running) return;
    setControlBusy(true);
    try {
      const resp = await D.postJson('/api/bot/strategy', { strategyId });
      D.getState().selectedStrategy = resp.selectedStrategy || strategyId;
      renderStrategies(resp.strategies || D.getState().strategies, D.getState().selectedStrategy);
    } catch (e) {
      prependLog(botLog, `<strong>strategy change failed</strong> ${e.message}`, 'bot-exit');
    } finally {
      setControlBusy(false);
    }
  }

  D.subscribePortfolio(() => {
    refreshSizingPreview();
  });

  D.subscribe((msg) => {
    if (msg.source === 'system' && (msg.type === 'init' || msg.type === 'status' || msg.type === 'hello')) {
      if (D.getState().strategies.length) {
        renderStrategies(D.getState().strategies, D.getState().selectedStrategy);
      }
      if (msg.bot) cachedProfile = { ...cachedProfile, ...msg.bot };
      if (msg.bot?.runProgress) D.getState().bot.runProgress = msg.bot.runProgress;
      renderBotControl();
      syncRunStatusTimer();
      refreshSizingPreview();
    }
    if (msg.source === 'lab' && msg.type === 'preset_applied' && msg.profile) {
      applyNamedProfile(msg.profile);
    }
    if (msg.source === 'bot') {
      if (msg.type === 'state') {
        if (msg.runProgress) D.getState().bot.runProgress = msg.runProgress;
        renderBotControl();
        renderRunStatus();
      }
      if (msg.type === 'run_progress') {
        D.getState().bot.runProgress = { ...msg };
        renderRunStatus();
      }
      if (msg.type === 'portfolio_snapshot') {
        D.applyPortfolioSnapshot({
          mode: msg.mode,
          cash: msg.cash ?? msg.bankroll,
          startingCash: msg.startingCash ?? msg.startingBankroll,
          netCashDelta: msg.netCashDelta,
          envStartingCash: msg.envStartingCash,
          portfolio: msg.portfolio ?? msg.totalEquity,
          realizedPnlTotal: msg.realizedPnlTotal,
          openPositions: msg.openPositions,
          openPositionValue: msg.openPositionValue,
          totalUnrealizedPnl: msg.totalUnrealizedPnl,
          totalEquity: msg.totalEquity ?? msg.portfolio,
          roiPct: msg.roiPct,
        });
      }
      if (msg.type === 'log') {
        const cls = msg.level === 'error' ? 'bot-exit' : msg.level === 'warn' ? 'bot-check' : '';
        prependLog(botLog, `<strong>${msg.level || 'log'}</strong> ${msg.message} @ ${D.fmtTs(msg.timestamp)}`, cls);
      } else if (msg.type !== 'portfolio_snapshot' && msg.type !== 'state') {
        const cls = msg.type === 'entry' ? 'bot-entry'
          : msg.type === 'exit' ? 'bot-exit'
          : msg.type === 'entry_skip' ? 'bot-skip'
          : 'bot-check';
        const detail = msg.logLine || msg.detail || msg.eventType || '';
        prependLog(botLog, `<strong>${msg.type}</strong> ${detail} @ ${D.fmtTs(msg.timestamp)}`, cls);
      }
      renderBotControl();
    }
  });

  if (botStrategySelect) {
    botStrategySelect.addEventListener('change', () => setStrategy(botStrategySelect.value));
  }
  if (botProfileSelect) {
    botProfileSelect.addEventListener('change', () => {
      if (D.getState().bot.running) return;
      selectProfile(botProfileSelect.value).catch((e) => {
        prependLog(botLog, `<strong>profile load failed</strong> ${e.message}`, 'bot-exit');
      });
    });
  }
  if (botStartBtn) botStartBtn.addEventListener('click', startBot);
  if (botStopBtn) botStopBtn.addEventListener('click', stopBot);

  S.bindSizingControls({
    panels: botSizingPanels,
    betPercentSlider: botBetPercentSlider,
    betPercentInput: botBetPercentInput,
    kellySlider: botKellyCapInput,
    name: 'bot-sizing-mode',
    onChange: refreshSizingPreview,
  });

  if (P) {
    P.bindTradingControls(botProfileEls, refreshTradingPreview);
    P.bindRunDurationControls(botProfileEls, () => {
      Object.assign(cachedProfile, P.readRunDurationFromForm(botProfileEls));
    });
  }

  renderStrategies(D.getState().strategies, D.getState().selectedStrategy);
  renderBotControl();
  refreshSizingPreview();
  refreshTradingPreview();
  loadProfiles()
    .catch(() => fetch('/api/bot/profile')
      .then((r) => r.json())
      .then((resp) => {
        if (resp.namedProfile) applyNamedProfile(resp.namedProfile);
        else if (resp.profile) cachedProfile = { ...resp.profile };
      }))
    .catch(() => {});
})();
