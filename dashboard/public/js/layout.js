/**
 * Shared chrome: nav, connection status, market window selector.
 */
(() => {
  const D = window.Dashboard;
  if (!D) return;

  const NAV_ITEMS = [
    { href: '/live', label: 'Live', group: 'trade' },
    { href: '/orderbook', label: 'Orderbook', group: 'trade' },
    { href: '/markets', label: 'Markets', group: 'trade' },
    { href: '/bot', label: 'Bot', group: 'control' },
    { href: '/portfolio', label: 'Portfolio', group: 'control' },
    { href: '/lab', label: 'Strategy Lab', group: 'tools' },
    { href: '/latency', label: 'Latency', group: 'tools' },
    { href: '/docs', label: 'Docs', group: 'tools' },
  ];

  const PAGE_CONTEXT = {
    bot: { label: 'Control panel', desc: 'Profile, strategy, sizing & run controls' },
    portfolio: { label: 'Paper account', desc: 'Bankroll, positions & trade history' },
    lab: { label: 'Strategy Lab', desc: 'Microstructure gates & preset builder' },
    latency: { label: 'Stream timing', desc: 'Feed latency & trade depth metrics' },
    backtest: { label: 'Backtest', desc: 'Run historical simulations locally' },
  };

  const PAGES_WITH_POLY_MODE = new Set(['live', 'orderbook', 'lab']);

  function isDebug() {
    try {
      return new URLSearchParams(window.location.search).has('debug')
        || localStorage.getItem('dashboardDebug') === '1';
    } catch (_) {
      return false;
    }
  }

  window.DashboardLayout = { isDebug, NAV_ITEMS, PAGE_CONTEXT };

  const polyModeSelect = document.getElementById('poly-mode-select');
  const wsStatus = document.getElementById('ws-status');
  const binanceStatus = document.getElementById('binance-status');
  const polyStatus = document.getElementById('poly-status');
  const botStatus = document.getElementById('bot-status');
  const pageId = document.body.dataset.page || 'live';

  function injectBodyClass() {
    document.body.classList.add(`page-${pageId}`);
  }

  function injectNav() {
    const nav = document.querySelector('.app-nav');
    if (!nav || nav.dataset.managed === '1') return;
    nav.dataset.managed = '1';

    let lastGroup = null;
    const parts = [];
    for (const item of NAV_ITEMS) {
      const page = item.href.replace(/^\//, '') || 'live';
      const active = page === pageId || (pageId === 'live' && page === 'live');
      if (lastGroup && item.group !== lastGroup) {
        parts.push('<span class="nav-divider" aria-hidden="true"></span>');
      }
      lastGroup = item.group;
      parts.push(
        `<a href="${item.href}" class="nav-link${active ? ' active' : ''}" data-nav-group="${item.group}">${item.label}</a>`,
      );
    }
    nav.innerHTML = parts.join('');
  }

  function injectPageContext() {
    const ctx = PAGE_CONTEXT[pageId];
    if (!ctx) return;
    const main = document.querySelector('main');
    if (!main || main.querySelector('.page-context-strip')) return;
    const strip = document.createElement('div');
    strip.className = 'page-context-strip';
    strip.innerHTML = `
      <span class="page-context-label">${ctx.label}</span>
      <span class="page-context-sep" aria-hidden="true">·</span>
      <span class="page-context-desc">${ctx.desc}</span>
    `;
    main.insertBefore(strip, main.firstChild);
  }

  function hideIrrelevantChrome() {
    const topControls = document.querySelector('.top-controls');
    if (topControls && !PAGES_WITH_POLY_MODE.has(pageId)) {
      topControls.hidden = true;
    }
  }

  function setActiveNav() {
    document.querySelectorAll('.app-nav .nav-link').forEach((a) => {
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

  const MOON_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5Z"/></svg>';
  const SUN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm0-16h1.5v3H12V2Zm0 19h1.5v3H12v-3ZM2 11h3v1.5H2V11Zm19 0h3v1.5h-3V11ZM4.2 4.2l2.1 2.1-1.1 1.1-2.1-2.1 1.1-1.1Zm13.6 13.6 2.1 2.1-1.1 1.1-2.1-2.1 1.1-1.1ZM4.2 19.8l1.1-1.1 2.1 2.1-1.1 1.1-2.1-2.1Zm13.6-13.6 1.1-1.1 2.1 2.1-1.1 1.1-2.1-2.1Z"/></svg>';

  function syncThemeToggleUi() {
    const theme = window.DashboardTheme?.getTheme?.() || 'dark';
    document.querySelectorAll('.theme-toggle-btn[data-theme-choice]').forEach((btn) => {
      const active = btn.getAttribute('data-theme-choice') === theme;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function injectThemeToggle() {
    const bar = document.querySelector('.status-bar');
    if (!bar || bar.querySelector('.theme-toggle')) return;

    let utilities = bar.querySelector('.header-utilities');
    if (!utilities) {
      utilities = document.createElement('div');
      utilities.className = 'header-utilities';
      bar.insertBefore(utilities, bar.firstChild);
    }

    const wrap = document.createElement('div');
    wrap.className = 'theme-toggle';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Color theme');
    wrap.innerHTML = `
      <button type="button" class="theme-toggle-btn" data-theme-choice="dark" aria-label="Dark mode" title="Dark mode">${MOON_ICON}</button>
      <button type="button" class="theme-toggle-btn" data-theme-choice="light" aria-label="Light mode" title="Light mode">${SUN_ICON}</button>
    `;
    utilities.appendChild(wrap);
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-theme-choice]');
      if (!btn || !window.DashboardTheme) return;
      window.DashboardTheme.applyTheme(btn.getAttribute('data-theme-choice'));
    });
    syncThemeToggleUi();
  }

  window.addEventListener('dashboard-theme-change', syncThemeToggleUi);

  injectBodyClass();
  injectNav();
  injectThemeToggle();
  hideIrrelevantChrome();
  injectPageContext();
  setActiveNav();
  renderStatusPills();
})();
