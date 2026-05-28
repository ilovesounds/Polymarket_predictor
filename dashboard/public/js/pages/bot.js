(() => {
  const D = window.Dashboard;
  const MAX_LOG = 120;

  const botStrategySelect = document.getElementById('bot-strategy-select');
  const botStartBtn = document.getElementById('bot-start-btn');
  const botStopBtn = document.getElementById('bot-stop-btn');
  const botBankroll = document.getElementById('bot-bankroll');
  const botLog = document.getElementById('bot-log');
  const botPid = document.getElementById('bot-pid');
  const botMode = document.getElementById('bot-mode');
  const positionsEl = document.getElementById('bot-positions');

  let controlBusy = false;

  function prependLog(el, html, cls) {
    if (!el) return;
    const line = document.createElement('div');
    line.className = `line ${cls || ''}`.trim();
    line.innerHTML = html;
    el.prepend(line);
    while (el.children.length > MAX_LOG) el.removeChild(el.lastChild);
  }

  function renderStrategies(strategies = [], current) {
    if (!botStrategySelect || !strategies.length) return;
    botStrategySelect.innerHTML = strategies
      .map((s) => `<option value="${s.id}">${s.label}</option>`)
      .join('');
    botStrategySelect.value = current || D.getState().selectedStrategy;
  }

  function renderBotControl() {
    const bot = D.getState().bot;
    const running = Boolean(bot.running);
    if (botStartBtn) botStartBtn.disabled = running || controlBusy;
    if (botStopBtn) botStopBtn.disabled = !running || controlBusy;
    if (botStrategySelect) botStrategySelect.disabled = controlBusy || running;
    if (botBankroll) botBankroll.textContent = D.fmtDollars(bot.bankroll);
    if (botPid) botPid.textContent = running && bot.pid ? String(bot.pid) : '—';
    if (botMode) botMode.textContent = bot.mode || 'paper';
  }

  function setControlBusy(next) {
    controlBusy = next;
    renderBotControl();
  }

  async function startBot() {
    setControlBusy(true);
    try {
      const resp = await D.postJson('/api/bot/start');
      if (resp.bot) {
        const s = D.getState().bot;
        Object.assign(s, resp.bot);
      }
      renderBotControl();
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

  function renderPositions(msg) {
    if (!positionsEl) return;
    if (msg.type === 'entry' || msg.type === 'exit') {
      const row = document.createElement('div');
      row.className = 'position-row';
      const bankroll = Number.isFinite(msg.bankrollAfter) ? D.fmtDollars(msg.bankrollAfter) : '—';
      row.innerHTML = `<span class="pos-type">${msg.type}</span> ${msg.detail || msg.eventType || ''} · ${bankroll} · ${D.fmtTs(msg.timestamp)}`;
      positionsEl.prepend(row);
      while (positionsEl.children.length > 30) positionsEl.removeChild(positionsEl.lastChild);
    }
  }

  D.subscribe((msg) => {
    if (msg.source === 'system' && (msg.type === 'init' || msg.type === 'status' || msg.type === 'hello')) {
      if (D.getState().strategies.length) {
        renderStrategies(D.getState().strategies, D.getState().selectedStrategy);
      }
      renderBotControl();
    }
    if (msg.source === 'bot') {
      if (msg.type === 'state') renderBotControl();
      if (msg.type === 'log') {
        const cls = msg.level === 'error' ? 'bot-exit' : msg.level === 'warn' ? 'bot-check' : '';
        prependLog(botLog, `<strong>${msg.level || 'log'}</strong> ${msg.message} @ ${D.fmtTs(msg.timestamp)}`, cls);
      } else {
        const cls = msg.type === 'entry' ? 'bot-entry' : msg.type === 'exit' ? 'bot-exit' : 'bot-check';
        const detail = msg.detail || msg.eventType || '';
        const price = msg.yesPrice != null ? ` yes=${D.fmtPrice(msg.yesPrice, 3)}` : '';
        prependLog(botLog, `<strong>${msg.type}</strong> ${detail}${price} @ ${D.fmtTs(msg.timestamp)}`, cls);
        renderPositions(msg);
      }
      renderBotControl();
    }
  });

  if (botStrategySelect) {
    botStrategySelect.addEventListener('change', () => setStrategy(botStrategySelect.value));
  }
  if (botStartBtn) botStartBtn.addEventListener('click', startBot);
  if (botStopBtn) botStopBtn.addEventListener('click', stopBot);

  renderStrategies(D.getState().strategies, D.getState().selectedStrategy);
  renderBotControl();
})();
