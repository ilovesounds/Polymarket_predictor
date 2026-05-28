(() => {
  const D = window.Dashboard;

  const marketsEl = document.getElementById('markets-table');
  const marketsMeta = document.getElementById('markets-meta');

  function renderMarkets() {
    const s = D.getState();
    const now = Date.now();
    const markets = s.activePolyMarkets;
    if (marketsMeta) {
      marketsMeta.textContent = `${markets.length} active · ${s.selectedPolyMode} window · ${D.fmtTs(now)}`;
    }
    if (!marketsEl) return;
    if (!markets.length) {
      marketsEl.innerHTML = '<div class="market-row empty">No active BTC 5m/15m markets for this window.</div>';
      return;
    }
    marketsEl.innerHTML = markets
      .map((m, idx) => {
        const remaining = Number.isFinite(m.endTime) ? m.endTime - now : NaN;
        const countdown = Number.isFinite(remaining) && remaining > 0
          ? D.fmtCountdown(remaining)
          : 'resolved';
        const live = idx === 0 ? '<span class="live-tag">PRIMARY</span>' : '';
        const q = (m.question || m.conditionId || '').slice(0, 80);
        const end = Number.isFinite(m.endTime)
          ? new Date(m.endTime).toLocaleTimeString(undefined, { hour12: false })
          : '—';
        return `<div class="market-row detailed${idx === 0 ? ' primary' : ''}">
          <div class="market-row-top">${live}<strong>${m.windowMinutes}m</strong> · resolves ${countdown}</div>
          <div class="market-row-q">${q}</div>
          <div class="market-row-meta">end ${end} · ${(m.conditionId || '').slice(0, 14)}…</div>
        </div>`;
      })
      .join('');
  }

  D.subscribe((msg) => {
    if (msg.source === 'polymarket' && msg.type === 'markets') renderMarkets();
    if (msg.source === 'system' && (msg.type === 'init' || msg.type === 'mode_changed')) renderMarkets();
  });

  setInterval(renderMarkets, 1000);
  renderMarkets();
})();
