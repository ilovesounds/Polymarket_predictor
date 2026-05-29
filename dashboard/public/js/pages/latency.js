/**
 * Latency dashboard page — live stream + trade-depth metrics.
 */
(() => {
  const D = window.Dashboard;
  if (!D) return;

  const metricsBtc = document.getElementById('metrics-btc');
  const metricsPoly = document.getElementById('metrics-poly');
  const tradeSummary = document.getElementById('trade-summary');
  const tradeEvents = document.getElementById('trade-events');
  const updatedEl = document.getElementById('latency-updated');

  const BTC_STREAMS = [
    { key: 'binance_ws', label: 'Binance WebSocket', sub: 'Trade time → local receive' },
    { key: 'coinbase_ws', label: 'Coinbase WebSocket', sub: 'Ticker time → local receive' },
    { key: 'kraken_ws', label: 'Kraken WebSocket', sub: 'Ticker → local receive' },
    { key: 'chainlink_oracle_age', label: 'Chainlink oracle age', sub: 'On-chain update → poll' },
    { key: 'chainlink_poll_rtt', label: 'Chainlink RPC', sub: 'Round-trip per poll' },
  ];

  const POLY_STREAMS = [
    { key: 'poly_ws_price', label: 'CLOB WS price', sub: 'Event timestamp → local' },
    { key: 'poly_ws_trade', label: 'CLOB WS trades', sub: 'Trade timestamp → local' },
    { key: 'poly_midpoint_rest', label: 'Midpoint REST', sub: 'HTTP round-trip' },
    { key: 'poly_orderbook_rest', label: 'Orderbook REST', sub: 'HTTP round-trip' },
    { key: 'poly_orderbook_poll', label: 'Orderbook poll', sub: 'Dashboard poll cycle' },
  ];

  function fmtMs(v) {
    if (!Number.isFinite(v)) return '—';
    return `${v} ms`;
  }

  function latencyClass(ms) {
    if (!Number.isFinite(ms)) return '';
    if (ms <= 150) return 'latency-good';
    if (ms <= 500) return 'latency-warn';
    return 'latency-bad';
  }

  function renderMetricRow(def, stats) {
    const s = stats?.[def.key];
    if (!s?.count) {
      return `<div class="metric-row"><div class="metric-label">${def.label}</div><div class="metric-value">—</div><div class="metric-sublabel">${def.sub}</div></div>`;
    }
    const latest = s.latest;
    return `
      <div class="metric-row">
        <div class="metric-label">${def.label}</div>
        <div class="metric-value ${latencyClass(latest)}">${fmtMs(latest)}</div>
        <div class="metric-sublabel">${def.sub} · ${s.count} samples</div>
        <div class="metric-stats">
          <span>p50 <strong>${fmtMs(s.p50)}</strong></span>
          <span>p95 <strong>${fmtMs(s.p95)}</strong></span>
          <span>avg <strong>${fmtMs(s.avg)}</strong></span>
          <span>min <strong>${fmtMs(s.min)}</strong></span>
        </div>
      </div>`;
  }

  function renderTradeSummary(td) {
    if (!td?.count) {
      tradeSummary.innerHTML = '<p class="metric-empty">No bot entries yet. Start the bot from the Bot page to measure trade → depth timing.</p>';
      return;
    }
    const items = [
      { label: 'Entries', value: td.count },
      { label: 'Depth fetch p50', value: fmtMs(td.depthFetch?.p50) },
      { label: 'Decision → depth p50', value: fmtMs(td.decisionToDepth?.p50) },
      { label: 'First depth change p50', value: fmtMs(td.firstDepthChange?.p50) },
    ];
    tradeSummary.innerHTML = items.map((i) => `
      <div class="trade-stat">
        <div class="trade-stat-label">${i.label}</div>
        <div class="trade-stat-value">${i.value}</div>
      </div>`).join('');
  }

  function renderTradeEvents(td) {
    const rows = td?.recent || [];
    if (!rows.length) {
      tradeEvents.innerHTML = '';
      return;
    }
    tradeEvents.innerHTML = rows.map((t) => {
      const polls = (t.postEntryPolls || []).slice(-4);
      const pollHtml = polls.length
        ? `<div class="trade-poll-list">${polls.map((p) => `+${p.msSinceEntry}ms depth=${Number.isFinite(p.depth) ? p.depth.toFixed(0) : '—'} Δ${Number.isFinite(p.depthDelta) ? p.depthDelta.toFixed(0) : '—'} rtt=${fmtMs(p.rttMs)}`).join(' · ')}</div>`
        : '';
      return `
        <article class="trade-event">
          <div class="trade-event-head">
            <span>${t.tradeId || 'trade'}</span>
            <span>${D.fmtTs(t.recordedAt || Date.now())}</span>
          </div>
          <div class="trade-event-body">
            <strong>orderbookDepthAtEntry</strong> ${Number.isFinite(t.orderbookDepthAtEntry) ? t.orderbookDepthAtEntry.toFixed(0) : '—'}
            · depth fetch ${fmtMs(t.depthFetchMs)}
            · decision→depth ${fmtMs(t.decisionToDepthMs)}
            ${pollHtml}
          </div>
        </article>`;
    }).join('');
  }

  function renderSnapshot(snap) {
    if (!snap) return;
    metricsBtc.innerHTML = BTC_STREAMS.map((d) => renderMetricRow(d, snap.streams)).join('');
    metricsPoly.innerHTML = POLY_STREAMS.map((d) => renderMetricRow(d, snap.streams)).join('');
    renderTradeSummary(snap.tradeDepth);
    renderTradeEvents(snap.tradeDepth);
    if (updatedEl && snap.timestamp) {
      updatedEl.textContent = `Updated ${D.fmtTs(snap.timestamp)}`;
    }
  }

  async function fetchSnapshot() {
    try {
      const snap = await fetch('/api/latency').then((r) => r.json());
      renderSnapshot(snap);
    } catch (_) {}
  }

  D.subscribe((msg) => {
    if (msg.source === 'latency' && msg.type === 'snapshot') {
      renderSnapshot(msg);
    }
  });

  fetchSnapshot();
  if (typeof D.connectEventStream === 'function') D.connectEventStream();
})();
