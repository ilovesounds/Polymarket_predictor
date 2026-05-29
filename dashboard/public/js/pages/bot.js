(() => {
  const D = window.Dashboard;
  const P = window.BotProfileUi;
  const MAX_LOG = 120;

  const botStrategySelect = document.getElementById('bot-strategy-select');
  const botMarketWindowSelect = document.getElementById('bot-market-window-select');
  const botRunLimitSelect = document.getElementById('bot-run-limit-select');
  const botRunCustomTrades = document.getElementById('bot-run-custom-trades');
  const botRunCustomGroup = document.querySelector('.bot-run-custom');
  const botStartBtn = document.getElementById('bot-start-btn');
  const botStopBtn = document.getElementById('bot-stop-btn');
  const botSaveProfileBtn = document.getElementById('bot-save-profile-btn');
  const botCash = document.getElementById('bot-cash');
  const botStartingCash = document.getElementById('bot-starting-cash');
  const botLog = document.getElementById('bot-log');
  const botPid = document.getElementById('bot-pid');
  const botMode = document.getElementById('bot-mode');
  const positionsEl = document.getElementById('bot-positions');
  const botUpnlEl = document.getElementById('bot-upnl');
  const botEquityEl = document.getElementById('bot-equity');

  const profileEls = {
    strategySelect: botStrategySelect,
    marketWindowSelect: botMarketWindowSelect,
    runLimitSelect: botRunLimitSelect,
    runCustomTrades: botRunCustomTrades,
    runCustomGroup: botRunCustomGroup,
    stopLossMode: document.getElementById('bot-stop-loss-mode'),
    stopLossValue: document.getElementById('bot-stop-loss-value'),
    stopLossSlider: document.getElementById('bot-stop-loss-slider'),
    stopLossValueLabel: document.getElementById('bot-stop-loss-value-label'),
    entryMinSeconds: document.getElementById('bot-entry-min-seconds'),
    entryMaxSeconds: document.getElementById('bot-entry-max-seconds'),
    entryMinPrice: document.getElementById('bot-entry-min-price'),
    entryMaxPrice: document.getElementById('bot-entry-max-price'),
    maxTradesPerMarket: document.getElementById('bot-max-trades-market'),
  };

  let controlBusy = false;

  function prependLog(el, html, cls) {
    if (!el) return;
    const line = document.createElement('div');
    line.className = `line ${cls || ''}`.trim();
    line.innerHTML = html;
    el.prepend(line);
    while (el.children.length > MAX_LOG) el.removeChild(el.lastChild);
  }

  function currentProfilePayload() {
    const payload = P.readProfileFromForm(profileEls);
    if (profileEls.stopLossMode?.value === 'off') {
      payload.stopLossPct = null;
      payload.stopLossPrice = null;
    }
    return payload;
  }

  function applyProfileToUi(profile) {
    if (!profile) return;
    P.applyProfileToForm(profile, profileEls);
    if (profile.strategyId) D.getState().selectedStrategy = profile.strategyId;
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
      botStrategySelect,
      botMarketWindowSelect,
      botRunLimitSelect,
      botRunCustomTrades,
      profileEls.stopLossMode,
      profileEls.stopLossValue,
      profileEls.stopLossSlider,
      profileEls.entryMinSeconds,
      profileEls.entryMaxSeconds,
      profileEls.entryMinPrice,
      profileEls.entryMaxPrice,
      profileEls.maxTradesPerMarket,
      botSaveProfileBtn,
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
    if (botCash) botCash.textContent = D.fmtDollars(bot.cash);
    if (botPid) botPid.textContent = running && bot.pid ? String(bot.pid) : '—';
    if (botMode) botMode.textContent = bot.mode || 'paper';
  }

  function renderPortfolioSummary(portfolio) {
    if (botCash && Number.isFinite(portfolio.cash)) {
      botCash.textContent = D.fmtDollars(portfolio.cash);
    }
    if (botStartingCash) botStartingCash.textContent = D.fmtDollars(portfolio.startingCash);
    if (botUpnlEl) {
      botUpnlEl.textContent = D.fmtDollars(portfolio.totalUnrealizedPnl);
      botUpnlEl.className = `metric-value ${D.pnlClass(portfolio.totalUnrealizedPnl)}`.trim();
    }
    if (botEquityEl) botEquityEl.textContent = D.fmtDollars(portfolio.portfolio ?? portfolio.totalEquity);
  }

  function setControlBusy(next) {
    controlBusy = next;
    renderBotControl();
  }

  async function saveBotProfile() {
    const payload = currentProfilePayload();
    const resp = await D.postJson('/api/bot/profile', payload);
    if (resp.profile) applyProfileToUi(resp.profile);
    P.saveDraft(resp.profile || payload);
    return resp;
  }

  async function startBot() {
    setControlBusy(true);
    try {
      await saveBotProfile();
      const resp = await D.postJson('/api/bot/start', currentProfilePayload());
      if (resp.bot) Object.assign(D.getState().bot, resp.bot);
      renderBotControl();
      prependLog(botLog, '<strong>started</strong> with saved profile', 'bot-entry');
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
    } catch (e) {
      prependLog(botLog, `<strong>stop failed</strong> ${e.message}`, 'bot-exit');
    } finally {
      setControlBusy(false);
    }
  }

  async function setStrategy(strategyId) {
    setControlBusy(true);
    try {
      const resp = await D.postJson('/api/bot/strategy', { strategyId });
      D.getState().selectedStrategy = resp.selectedStrategy || strategyId;
      renderStrategies(resp.strategies || D.getState().strategies, D.getState().selectedStrategy);
      prependLog(botLog, `<strong>strategy</strong> set to ${D.getState().selectedStrategy}`, 'bot-check');
    } catch (e) {
      prependLog(botLog, `<strong>strategy change failed</strong> ${e.message}`, 'bot-exit');
    } finally {
      setControlBusy(false);
    }
  }

  function appendTradeEvent(msg) {
    if (!positionsEl) return;
    const row = document.createElement('div');
    row.className = 'position-row position-event';
    const text = msg.logLine || msg.detail || msg.eventType || '';
    const shares = Number.isFinite(msg.shares)
      ? ` · ${msg.shares.toFixed(2)} ${String(msg.direction || 'YES').toUpperCase()} sh`
      : '';
    row.innerHTML = `<span class="pos-type">${msg.type}</span> ${text}${shares} · ${D.fmtTs(msg.timestamp)}`;
    positionsEl.prepend(row);
    while (positionsEl.querySelectorAll('.position-event').length > 8) {
      const last = [...positionsEl.querySelectorAll('.position-event')].pop();
      last?.remove();
    }
  }

  function renderOpenPositions(openPositions = []) {
    if (!positionsEl) return;
    const events = [...positionsEl.querySelectorAll('.position-event')];
    if (!openPositions.length) {
      positionsEl.innerHTML = '<div class="market-row empty">No open positions. Trade events appear here when the bot runs.</div>';
      for (const row of events) positionsEl.prepend(row);
      return;
    }
    const openHtml = openPositions.map((pos) => {
      const market = pos.question || pos.marketId || '—';
      const side = String(pos.side || 'YES').toUpperCase();
      const upnl = pos.unrealizedPnl;
      const upnlPct = pos.unrealizedPnlPct;
      const upnlText = Number.isFinite(upnl)
        ? `<span class="${D.pnlClass(upnl)}">uPnL ${D.fmtDollars(upnl)}</span>`
        : '';
      const pctText = Number.isFinite(upnlPct)
        ? ` <span class="${D.pnlClass(upnlPct)}">(${upnlPct > 0 ? '+' : ''}${upnlPct.toFixed(2)}%)</span>`
        : '';
      return `<div class="position-row position-open">
        <span class="pos-type open">open</span>
        <span class="pos-market">${market}</span>
        <span class="pos-detail">${D.fmtSize(pos.shares)} ${side} · entry ${D.fmtPrice(pos.entryPrice, 2)} · now ${D.fmtPrice(pos.currentPrice, 2)} · value ${D.fmtDollars(pos.currentValue)}</span>
        <span class="pos-pnl">${upnlText}${pctText}</span>
      </div>`;
    }).join('');
    positionsEl.innerHTML = openHtml;
    for (const row of events) positionsEl.appendChild(row);
  }

  function renderFromPortfolio(portfolio) {
    renderPortfolioSummary(portfolio);
    renderOpenPositions(portfolio.openPositions || []);
    renderBotControl();
  }

  D.subscribePortfolio((portfolio) => {
    renderFromPortfolio(portfolio);
  });

  D.subscribe((msg) => {
    if (msg.source === 'system' && (msg.type === 'init' || msg.type === 'status' || msg.type === 'hello')) {
      if (D.getState().strategies.length) {
        renderStrategies(D.getState().strategies, D.getState().selectedStrategy);
      }
      if (msg.bot) applyProfileToUi(msg.bot);
      renderFromPortfolio(D.getPortfolio());
    }
    if (msg.source === 'lab' && msg.type === 'preset_applied' && msg.profile) {
      applyProfileToUi(msg.profile);
    }
    if (msg.source === 'bot') {
      if (msg.type === 'state') renderBotControl();
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
        if (msg.type === 'entry' || msg.type === 'exit') appendTradeEvent(msg);
      }
      renderBotControl();
    }
  });

  if (botStrategySelect) {
    botStrategySelect.addEventListener('change', () => setStrategy(botStrategySelect.value));
  }
  if (botRunLimitSelect) {
    botRunLimitSelect.addEventListener('change', () => {
      P.syncRunLimitCustomVisibility(profileEls);
      if (!D.getState().bot.running) saveBotProfile().catch(() => {});
    });
  }
  if (botMarketWindowSelect) {
    botMarketWindowSelect.addEventListener('change', () => {
      if (!D.getState().bot.running) saveBotProfile().catch(() => {});
    });
  }
  if (botRunCustomTrades) {
    botRunCustomTrades.addEventListener('change', () => {
      if (!D.getState().bot.running) saveBotProfile().catch(() => {});
    });
  }
  [
    profileEls.entryMinSeconds,
    profileEls.entryMaxSeconds,
    profileEls.entryMinPrice,
    profileEls.entryMaxPrice,
    profileEls.maxTradesPerMarket,
    profileEls.stopLossValue,
  ].forEach((el) => {
    el?.addEventListener('change', () => {
      if (!D.getState().bot.running) saveBotProfile().catch(() => {});
    });
  });
  if (botSaveProfileBtn) {
    botSaveProfileBtn.addEventListener('click', async () => {
      setControlBusy(true);
      try {
        await saveBotProfile();
        prependLog(botLog, '<strong>profile</strong> saved', 'bot-check');
      } catch (e) {
        prependLog(botLog, `<strong>save failed</strong> ${e.message}`, 'bot-exit');
      } finally {
        setControlBusy(false);
      }
    });
  }
  if (botStartBtn) botStartBtn.addEventListener('click', startBot);
  if (botStopBtn) botStopBtn.addEventListener('click', stopBot);

  P.bindStopLossControls(profileEls);

  renderStrategies(D.getState().strategies, D.getState().selectedStrategy);
  renderFromPortfolio(D.getPortfolio());
  fetch('/api/bot/profile')
    .then((r) => r.json())
    .then((resp) => {
      if (resp.profile) applyProfileToUi(resp.profile);
      else if (resp.botSession) applyProfileToUi(resp.botSession);
    })
    .catch(() => {
      const draft = P.loadDraft();
      if (draft) applyProfileToUi(draft);
    });

  window.DashboardCashAdjust?.wire({
    amountInputId: 'bot-cash-amount',
    addBtnId: 'bot-cash-add',
    removeBtnId: 'bot-cash-remove',
    statusElId: 'bot-cash-status',
  });
})();
