(() => {
  const polyModeSelect = document.getElementById('poly-mode-select');
  const wsStatus = document.getElementById('ws-status');
  const polyStatus = document.getElementById('poly-status');
  const polyYesPrice = document.getElementById('poly-yes-price');
  const polyNoPrice = document.getElementById('poly-no-price');
  const polyMeta = document.getElementById('poly-meta');
  const polyMarketTitle = document.getElementById('poly-market-title');
  const polyResolution = document.getElementById('poly-resolution');

  let selectedPolyMode = '15m';
  let primaryPolyConditionId = null;
  let primaryPolyEndTime = null;
  const polyLatest = { yes: null, no: null };

  const tradeTape = window.PolyTradeTape({
    tapeEl: document.getElementById('poly-trade-tape'),
    popupHostEl: document.getElementById('poly-trade-popups'),
  });

  function fmtPrice(v, digits = 3) {
    if (!Number.isFinite(v)) return '—';
    return v >= 1 ? v.toFixed(digits) : v.toFixed(4);
  }

  function fmtTs(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3 });
  }

  function modeToWindow(mode) {
    if (mode === '5m') return 5;
    if (mode === '15m') return 15;
    return null;
  }

  function resolvedPolyPrices() {
    let yes = polyLatest.yes;
    let no = polyLatest.no;
    if (Number.isFinite(yes) && !Number.isFinite(no)) no = Math.max(0, Math.min(1, 1 - yes));
    if (Number.isFinite(no) && !Number.isFinite(yes)) yes = Math.max(0, Math.min(1, 1 - no));
    return { yes, no };
  }

  function setPrimaryMarket(market) {
    primaryPolyConditionId = market?.conditionId || null;
    primaryPolyEndTime = Number.isFinite(market?.endTime) ? market.endTime : null;
    polyMarketTitle.textContent = market?.question || 'No active market';
    polyResolution.hidden = !Number.isFinite(primaryPolyEndTime);
  }

  function updateResolutionCountdown() {
    if (!Number.isFinite(primaryPolyEndTime)) return;
    const remaining = primaryPolyEndTime - Date.now();
    if (remaining <= 0) {
      polyResolution.textContent = 'Resolved';
      return;
    }
    const s = Math.floor(remaining / 1000);
    const m = Math.floor(s / 60);
    polyResolution.textContent = `Resolves in ${m}m ${s % 60}s`;
  }

  async function postJson(url, body = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json().catch(() => ({}));
  }

  function handleMessage(msg) {
    if (msg.source === 'system' && msg.type === 'status') {
      polyStatus.textContent = msg.polymarketConnected ? 'Polymarket live' : 'Polymarket waiting';
      polyStatus.className = `pill ${msg.polymarketConnected ? 'on' : 'off'}`;
      if (msg.selectedPolyMode) {
        selectedPolyMode = msg.selectedPolyMode;
        polyModeSelect.value = selectedPolyMode;
      }
      return;
    }

    if (msg.source === 'polymarket' && msg.type === 'markets' && Array.isArray(msg.markets)) {
      const w = modeToWindow(selectedPolyMode);
      const primary = msg.markets
        .filter((m) => m?.conditionId && (!w || m.windowMinutes === w))
        .sort((a, b) => a.endTime - b.endTime)[0];
      if (primary?.conditionId !== primaryPolyConditionId) {
        tradeTape.clear();
        polyLatest.yes = null;
        polyLatest.no = null;
      }
      setPrimaryMarket(primary || null);
      return;
    }

    if (msg.source === 'polymarket' && msg.type === 'price') {
      if (primaryPolyConditionId && msg.market?.conditionId !== primaryPolyConditionId) return;
      if (Number.isFinite(msg.yesPrice)) polyLatest.yes = msg.yesPrice;
      if (Number.isFinite(msg.noPrice)) polyLatest.no = msg.noPrice;
      const { yes, no } = resolvedPolyPrices();
      polyYesPrice.textContent = fmtPrice(yes);
      polyNoPrice.textContent = fmtPrice(no);
      polyMeta.textContent = fmtTs(msg.timestamp || Date.now());
      return;
    }

    if (msg.source === 'polymarket' && msg.type === 'trade') {
      if (primaryPolyConditionId && msg.market?.conditionId !== primaryPolyConditionId) return;
      tradeTape.onTrade(msg);
    }
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      wsStatus.textContent = 'WS connected';
      wsStatus.className = 'pill on';
    };
    ws.onclose = () => {
      wsStatus.textContent = 'WS disconnected';
      wsStatus.className = 'pill off';
      setTimeout(connect, 1500);
    };
    ws.onmessage = (ev) => {
      try { handleMessage(JSON.parse(ev.data)); } catch (_) {}
    };
  }

  polyModeSelect.addEventListener('change', () => {
    postJson('/api/polymarket/mode', { mode: polyModeSelect.value }).catch(() => {});
  });

  fetch('/api/polymarket/mode')
    .then((r) => r.json())
    .then((d) => {
      selectedPolyMode = d.selectedPolyMode || selectedPolyMode;
      polyModeSelect.value = selectedPolyMode;
    })
    .catch(() => {});

  setInterval(updateResolutionCountdown, 1000);
  connect();
})();
