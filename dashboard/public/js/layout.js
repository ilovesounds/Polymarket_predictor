/**
 * Shared chrome: nav, connection status, market window selector.
 */
(() => {
  const D = window.Dashboard;
  if (!D) return;

  const NAV_ITEMS = [
    { href: '/live', label: 'Live' },
    { href: '/orderbook', label: 'Orderbook' },
    { href: '/bot', label: 'Bot' },
    { href: '/portfolio', label: 'Portfolio' },
    { href: '/markets', label: 'Markets' },
    { href: '/lab', label: 'Strategy Lab' },
    { href: '/latency', label: 'Latency' },
    { href: '/docs', label: 'Docs' },
  ];

  const PAGES_WITH_POLY_MODE = new Set(['live', 'orderbook', 'lab']);

  function isDebug() {
    try {
      return new URLSearchParams(window.location.search).has('debug')
        || localStorage.getItem('dashboardDebug') === '1';
    } catch (_) {
      return false;
    }
  }

  window.DashboardLayout = { isDebug, NAV_ITEMS };

  const polyModeSelect = document.getElementById('poly-mode-select');
  const wsStatus = document.getElementById('ws-status');
  const binanceStatus = document.getElementById('binance-status');
  const polyStatus = document.getElementById('poly-status');
  const botStatus = document.getElementById('bot-status');
  const pageId = document.body.dataset.page || 'live';

  function injectNav() {
    const nav = document.querySelector('.app-nav');
    if (!nav || nav.dataset.managed === '1') return;
    nav.dataset.managed = '1';
    nav.innerHTML = NAV_ITEMS.map((item) => {
      const page = item.href.replace(/^\//, '') || 'live';
      const active = page === pageId || (pageId === 'live' && page === 'live');
      return `<a href="${item.href}"${active ? ' class="active"' : ''}>${item.label}</a>`;
    }).join('');
  }

  function hideIrrelevantChrome() {
    const topControls = document.querySelector('.top-controls');
    if (topControls && !PAGES_WITH_POLY_MODE.has(pageId)) {
      topControls.hidden = true;
    }
  }

  function setActiveNav() {
    document.querySelectorAll('.app-nav a').forEach((a) => {
      const href = a.getAttribute('href');
      const page = href === '/' ? 'live' : href.replace(/^\//, '');
      const active = page === pageId || (pageId === 'live' && (href === '/' || href === '/live'));
      a.classList.toggle('active', active);
    });
  }

  function pillClass(state) {
    return `pill pill-sm ${state}`;
  }

  function renderStatusPills() {
    const s = D.getState();
    if (binanceStatus) {
      binanceStatus.textContent = s.binanceConnected ? 'Binance live' : 'Binance waiting';
      binanceStatus.className = pillClass(s.binanceConnected ? 'on' : 'off');
    }
    if (polyStatus) {
      const polyLive = Boolean(s.polymarketConnected);
      const natsNote = s.feedSource === 'nats' && !polyLive ? ' (NATS, no ticks)' : '';
      polyStatus.textContent = polyLive
        ? `Polymarket live${s.lastPolyVia ? ` · ${s.lastPolyVia}` : ''}`
        : `Polymarket waiting${natsNote}`;
      polyStatus.className = pillClass(polyLive ? 'on' : (s.natsConnected ? 'warn' : 'off'));
    }
    if (botStatus) {
      const running = Boolean(s.bot.running);
      let label = running ? `Bot live (${s.bot.mode || 'paper'})` : 'Bot idle';
      if (running && s.bot.runProgress?.label) {
        label += ` · ${s.bot.runProgress.label}`;
      }
      botStatus.textContent = label;
      botStatus.className = pillClass(running ? 'on' : 'off');
    }
    if (polyModeSelect) {
      polyModeSelect.value = s.selectedPolyMode;
    }
  }

  function renderWsPill(type) {
    if (!wsStatus) return;
    if (type === 'ws_open') {
      wsStatus.textContent = 'WS connected';
      wsStatus.className = pillClass('on');
    } else if (type === 'ws_close') {
      wsStatus.textContent = 'WS disconnected';
      wsStatus.className = pillClass('off');
    } else if (type === 'ws_error') {
      wsStatus.textContent = 'WS error';
      wsStatus.className = pillClass('warn');
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
    if (msg.source === 'bot' && (msg.type === 'state' || msg.type === 'run_progress')) renderStatusPills();
  });

  if (polyModeSelect) {
    polyModeSelect.addEventListener('change', onModeChange);
  }

  injectNav();
  hideIrrelevantChrome();
  setActiveNav();
  renderStatusPills();
})();
