/**
 * Shared chrome: nav, connection status, market window selector.
 */
(() => {
  const D = window.Dashboard;
  if (!D) return;

  const polyModeSelect = document.getElementById('poly-mode-select');
  const wsStatus = document.getElementById('ws-status');
  const binanceStatus = document.getElementById('binance-status');
  const polyStatus = document.getElementById('poly-status');
  const botStatus = document.getElementById('bot-status');
  const pageId = document.body.dataset.page || 'live';

  function setActiveNav() {
    document.querySelectorAll('.app-nav a').forEach((a) => {
      const href = a.getAttribute('href');
      const active = href === `/${pageId}` || (pageId === 'live' && (href === '/' || href === '/live'));
      a.classList.toggle('active', active);
    });
  }

  function renderStatusPills() {
    const s = D.getState();
    if (binanceStatus) {
      binanceStatus.textContent = s.binanceConnected ? 'Binance live' : 'Binance waiting';
      binanceStatus.className = `pill ${s.binanceConnected ? 'on' : 'off'}`;
    }
    if (polyStatus) {
      const polyLive = Boolean(s.polymarketConnected);
      const natsNote = s.feedSource === 'nats' && !polyLive ? ' (NATS, no ticks)' : '';
      polyStatus.textContent = polyLive
        ? `Polymarket live${s.lastPolyVia ? ` · ${s.lastPolyVia}` : ''}`
        : `Polymarket waiting${natsNote}`;
      polyStatus.className = `pill ${polyLive ? 'on' : (s.natsConnected ? 'warn' : 'off')}`;
    }
    if (botStatus) {
      const running = Boolean(s.bot.running);
      botStatus.textContent = running ? `Bot live (${s.bot.mode || 'paper'})` : 'Bot idle';
      botStatus.className = `pill ${running ? 'on' : 'off'}`;
    }
    if (polyModeSelect) {
      polyModeSelect.value = s.selectedPolyMode;
    }
  }

  function renderWsPill(type) {
    if (!wsStatus) return;
    if (type === 'ws_open') {
      wsStatus.textContent = 'WS connected';
      wsStatus.className = 'pill on';
    } else if (type === 'ws_close') {
      wsStatus.textContent = 'WS disconnected';
      wsStatus.className = 'pill off';
    } else if (type === 'ws_error') {
      wsStatus.textContent = 'WS error';
      wsStatus.className = 'pill warn';
    }
  }

  let modeBusy = false;
  async function onModeChange() {
    if (!polyModeSelect || modeBusy) return;
    modeBusy = true;
    polyModeSelect.disabled = true;
    try {
      await D.setPolyMode(polyModeSelect.value);
    } catch (e) {
      console.warn('mode change failed', e.message);
      polyModeSelect.value = D.getState().selectedPolyMode;
    } finally {
      modeBusy = false;
      polyModeSelect.disabled = false;
    }
  }

  D.subscribe((msg) => {
    if (msg.source === 'system') {
      if (msg.type === 'ws_open' || msg.type === 'ws_close' || msg.type === 'ws_error') {
        renderWsPill(msg.type);
      }
      if (msg.type === 'status' || msg.type === 'init' || msg.type === 'mode_changed' || msg.type === 'hello') {
        renderStatusPills();
      }
    }
    if (msg.source === 'bot' && msg.type === 'state') renderStatusPills();
  });

  if (polyModeSelect) {
    polyModeSelect.addEventListener('change', onModeChange);
  }

  setActiveNav();
  renderStatusPills();
})();
