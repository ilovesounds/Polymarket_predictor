(() => {
  const D = window.Dashboard;
  const DEBUG = window.DashboardLayout?.isDebug?.() ?? false;
  const MAX_LOG = DEBUG ? 40 : 18;
  const MAX_TAPE = 50;

  const polyYesPrice = document.getElementById('poly-yes-price');
  const polyNoPrice = document.getElementById('poly-no-price');
  const exchangeCardsHost = document.getElementById('exchange-feed-cards');
  const polyMarketTitle = document.getElementById('poly-market-title');
  const polyResolution = document.getElementById('poly-resolution');
  const liveWarning = document.getElementById('live-market-warning');
  const polyLog = document.getElementById('poly-log');
  const polyLogDetails = document.getElementById('poly-log-details');

  const beatPriceValue = document.getElementById('beat-price-value');
  const beatSource = document.getElementById('beat-source');
  const beatBtcNow = document.getElementById('beat-btc-now');
  const beatChainlinkWrap = document.getElementById('beat-chainlink-wrap');
  const beatChainlinkNow = document.getElementById('beat-chainlink-now');
  const beatDelta = document.getElementById('beat-delta');

  const tradeTape = document.getElementById('trade-tape');
  const tradePopupHost = document.getElementById('trade-popup-host');
  const followLiveToggle = document.getElementById('follow-live-toggle');
  const btcChartContainer = document.getElementById('btc-price-chart');
  const microstructureStatus = document.getElementById('microstructure-status');
  const microstructureCards = document.getElementById('microstructure-cards');
  const btcUpPup = document.getElementById('btc-up-pup');
  const btcUpPolyYes = document.getElementById('btc-up-poly-yes');
  const btcUpEdge = document.getElementById('btc-up-edge');
  const btcUpEdgeThreshold = document.getElementById('btc-up-edge-threshold');
  const btcUpModelLabel = document.getElementById('btc-up-model-label');
  const btcUpEntrySignal = document.getElementById('btc-up-entry-signal');
  const btcUpSignalRow = document.getElementById('btc-up-signal-row');
  /** @type {Record<string, { card: HTMLElement, valueEl: HTMLElement, badgeEl: HTMLElement, hintEl: HTMLElement|null }>} */
  const microSignalUi = {};

  function buildMicrostructureCards() {
    if (!microstructureCards) return;
    for (const card of microstructureCards.querySelectorAll('.micro-signal-card')) {
      const key = card.dataset.signal;
      if (!key) continue;
      microSignalUi[key] = {
        card,
        valueEl: card.querySelector('[data-role="value"]'),
        badgeEl: card.querySelector('[data-role="badge"]'),
        hintEl: card.querySelector('[data-role="hint"]'),
      };
    }
  }

  function fmtRatio(v, digits = 3) {
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(digits);
  }

  function fmtPct(v, digits = 4) {
    if (!Number.isFinite(v)) return '—';
    const sign = v > 0 ? '+' : '';
    return `${sign}${(v * 100).toFixed(digits)}%`;
  }

  function fmtVol(v) {
    if (!Number.isFinite(v)) return '—';
    if (v < 0.0001) return v.toExponential(2);
    return v.toFixed(6);
  }

  function applySignalCardStyle(card, label, extraClass) {
    if (!card) return;
    card.classList.remove('bullish', 'bearish', 'neutral', 'elevated', 'normal');
    if (extraClass) card.classList.add(extraClass);
    else if (label === 'bullish' || label === 'bearish' || label === 'elevated' || label === 'normal') {
      card.classList.add(label);
    } else {
      card.classList.add('neutral');
    }
  }

  function renderMicrostructure(msg) {
    const signals = msg?.signals;
    if (!signals) return;

    if (microstructureStatus) {
      const n = msg.tradeCount60s ?? 0;
      microstructureStatus.textContent = n > 0 ? `Live · ${n} trades` : 'Waiting';
      microstructureStatus.className = `pill pill-sm ${n > 0 ? 'on' : 'off'}`;
    }

    const ofi = signals.ofi;
    if (microSignalUi.ofi) {
      const ui = microSignalUi.ofi;
      if (ui.valueEl) ui.valueEl.textContent = fmtRatio(ofi?.value);
      if (ui.badgeEl) ui.badgeEl.textContent = ofi?.label || '—';
      applySignalCardStyle(ui.card, ofi?.label);
      if (ui.badgeEl) ui.badgeEl.className = `micro-signal-badge ${ofi?.label || 'neutral'}`;
    }

    const agg = signals.aggressorRatio;
    if (microSignalUi.aggressorRatio) {
      const ui = microSignalUi.aggressorRatio;
      if (ui.valueEl) ui.valueEl.textContent = fmtRatio(agg?.value);
      if (ui.badgeEl) ui.badgeEl.textContent = agg?.label || '—';
      applySignalCardStyle(ui.card, agg?.label);
      if (ui.badgeEl) ui.badgeEl.className = `micro-signal-badge ${agg?.label || 'neutral'}`;
    }

    const vol = signals.realizedVol30s;
    if (microSignalUi.realizedVol30s) {
      const ui = microSignalUi.realizedVol30s;
      if (ui.valueEl) ui.valueEl.textContent = fmtVol(vol?.value);
      if (ui.badgeEl) ui.badgeEl.textContent = vol?.label || '—';
      applySignalCardStyle(ui.card, vol?.label, vol?.label === 'elevated' ? 'elevated' : 'neutral');
      if (ui.badgeEl) ui.badgeEl.className = `micro-signal-badge ${vol?.label || 'neutral'}`;
    }

    const mom = signals.momentum60s;
    if (microSignalUi.momentum60s) {
      const ui = microSignalUi.momentum60s;
      if (ui.valueEl) ui.valueEl.textContent = fmtPct(mom?.value);
      if (ui.badgeEl) ui.badgeEl.textContent = mom?.label || '—';
      applySignalCardStyle(ui.card, mom?.label);
      if (ui.badgeEl) ui.badgeEl.className = `micro-signal-badge ${mom?.label || 'neutral'}`;
    }

    const comp = signals.compositeConviction;
    if (microSignalUi.compositeConviction) {
      const ui = microSignalUi.compositeConviction;
      const conviction = comp?.conviction === 'high' ? 'High' : 'Low';
      const dir = comp?.label || 'neutral';
      if (ui.valueEl) {
        ui.valueEl.textContent = comp?.conviction === 'high'
          ? `${conviction} ${dir}`
          : `${conviction} · ${dir}`;
      }
      if (ui.badgeEl) {
        ui.badgeEl.textContent = comp?.conviction === 'high' ? dir : 'low';
      }
      applySignalCardStyle(ui.card, dir);
      if (ui.badgeEl) {
        ui.badgeEl.className = `micro-signal-badge ${comp?.conviction === 'high' ? dir : 'low'}`;
      }
      if (ui.hintEl && comp?.interpretation) {
        ui.hintEl.textContent = comp.interpretation;
      }
    }
  }

  async function loadMicrostructureSnapshot() {
    try {
      const snap = await fetch('/api/signals/microstructure').then((r) => r.json());
      if (snap?.signals) renderMicrostructure(snap);
    } catch (_) {}
  }

  function renderBtcUpModel(msg) {
    if (!msg || (msg.type && msg.type !== 'btc_up_model')) return;
    const pPct = Number.isFinite(msg.pUp) ? `${(msg.pUp * 100).toFixed(0)}%` : '—';
    const yPct = Number.isFinite(msg.polyYes) ? `${(msg.polyYes * 100).toFixed(0)}%` : '—';
    if (btcUpPup) btcUpPup.textContent = pPct;
    if (btcUpPolyYes) btcUpPolyYes.textContent = yPct;
    if (btcUpEdge) {
      btcUpEdge.classList.remove('positive', 'negative');
      if (Number.isFinite(msg.edgePct)) {
        const sign = msg.edgePct >= 0 ? '+' : '';
        btcUpEdge.textContent = `${sign}${msg.edgePct.toFixed(1)}%`;
        btcUpEdge.classList.add(msg.edgePct >= 0 ? 'positive' : 'negative');
      } else {
        btcUpEdge.textContent = '—';
      }
    }
    if (btcUpEdgeThreshold && Number.isFinite(msg.edgeThreshold)) {
      btcUpEdgeThreshold.textContent = `need ≥${(msg.edgeThreshold * 100).toFixed(0)}% edge`;
    }
    if (btcUpModelLabel) {
      const conf = msg.confidence || 'low';
      const label = msg.label || 'neutral';
      btcUpModelLabel.textContent = msg.coldStart
        ? 'Warming up (60s window) — P(up)=50%'
        : `${label} · ${conf} confidence`;
    }
    if (btcUpEntrySignal) {
      const on = Boolean(msg.entrySignal) && Boolean(msg.ready);
      btcUpEntrySignal.textContent = on ? 'Entry signal' : 'No edge';
      btcUpEntrySignal.className = `pill pill-sm ${on ? 'on' : 'off'}`;
    }
    if (btcUpSignalRow && msg.signals) {
      const chips = {
        ofi: msg.signals.ofi,
        aggressorRatio: msg.signals.aggressorRatio,
        realizedVol30s: msg.signals.realizedVol30s,
        momentum60s: msg.signals.momentum60s,
      };
      for (const chip of btcUpSignalRow.querySelectorAll('.btc-up-signal-chip')) {
        const key = chip.dataset.signal;
        const v = chips[key];
        if (!Number.isFinite(v)) {
          chip.textContent = `${key === 'aggressorRatio' ? 'Agg' : key === 'realizedVol30s' ? 'Vol' : key === 'momentum60s' ? 'Mom' : 'OFI'} —`;
          continue;
        }
        if (key === 'momentum60s') chip.textContent = `Mom ${(v * 100).toFixed(2)}%`;
        else if (key === 'realizedVol30s') chip.textContent = `Vol ${v.toExponential(1)}`;
        else if (key === 'aggressorRatio') chip.textContent = `Agg ${v.toFixed(2)}`;
        else chip.textContent = `OFI ${v.toFixed(2)}`;
      }
    }
  }

  async function loadBtcUpModelSnapshot() {
    try {
      const snap = await fetch('/api/signals/btc-up-model').then((r) => r.json());
      renderBtcUpModel(snap);
    } catch (_) {}
  }

  const MAX_POPUPS = 4;
  const POPUP_MS = 2600;
  const CHART_HISTORY_MS = 15 * 60_000;
  const CHART_MAX_POINTS = 3600;
  const Y_TICK_STEP = 25;

  function cssVar(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  function chartLineColor() {
    return cssVar('--chart-line', cssVar('--orange', '#f97316'));
  }

  function chartBeatLineColor() {
    return cssVar('--chart-beat-line', 'rgba(255, 255, 255, 0.42)');
  }

  const EXCHANGES = [
    { id: 'binance', label: 'Binance', pair: 'BTC/USDT', color: '#f0b90b' },
    { id: 'coinbase', label: 'Coinbase', pair: 'BTC/USD', color: '#0052ff' },
    { id: 'kraken', label: 'Kraken', pair: 'XBT/USD', color: '#7132f5' },
  ];
  const MINI_CHART_HISTORY_MS = 5 * 60_000;
  const MINI_CHART_MAX_POINTS = 600;

  /** @type {Record<string, { price: number|null, updatedAt: number|null, series: Array<{ t: number, p: number }>, connected: boolean }>} */
  const exchangeState = Object.fromEntries(
    EXCHANGES.map((ex) => [ex.id, { price: null, updatedAt: null, series: [], connected: false }]),
  );
  /** @type {Record<string, { card: HTMLElement, priceEl: HTMLElement, ageEl: HTMLElement, spreadEl: HTMLElement, statusEl: HTMLElement, logEl: HTMLElement|null, chart: object|null, lineSeries: object|null, chartRaf: number|null }>} */
  const exchangeUi = {};

  /** @type {Array<{ t: number, p: number }>} */
  const btcSeries = [];
  let chartRaf = null;
  /** @type {import('lightweight-charts').IChartApi|null} */
  let btcChart = null;
  /** @type {import('lightweight-charts').ISeriesApi<'Line'>|null} */
  let btcLineSeries = null;
  /** @type {import('lightweight-charts').IPriceLine|null} */
  let beatPriceLine = null;
  /** @type {import('lightweight-charts').IPriceLine|null} */
  let spotPriceLine = null;
  let chartResizeObserver = null;

  if (polyLogDetails) polyLogDetails.open = DEBUG;

  function fmtAgeMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function fmtSpreadDelta(delta, refPrice) {
    if (!Number.isFinite(delta) || !Number.isFinite(refPrice) || refPrice === 0) return null;
    const abs = Math.abs(delta);
    const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
    const pct = (delta / refPrice) * 100;
    return { text: `${sign}$${D.fmtPrice(abs)} (${sign}${Math.abs(pct).toFixed(3)}%)`, delta };
  }

  function mergeExchangeHistory(source, points) {
    const st = exchangeState[source];
    if (!st || !Array.isArray(points)) return;
    for (const pt of points) {
      if (!Number.isFinite(pt?.t) || !Number.isFinite(pt?.p)) continue;
      st.series.push({ t: pt.t, p: pt.p });
    }
    st.series.sort((a, b) => a.t - b.t);
    pruneExchangeSeries(source);
  }

  function pruneExchangeSeries(source, now = Date.now()) {
    const st = exchangeState[source];
    if (!st) return;
    const cutoff = now - MINI_CHART_HISTORY_MS;
    while (st.series.length && st.series[0].t < cutoff) st.series.shift();
    if (st.series.length > MINI_CHART_MAX_POINTS) {
      st.series.splice(0, st.series.length - MINI_CHART_MAX_POINTS);
    }
  }

  function pushExchangePoint(source, price, ts = Date.now()) {
    const st = exchangeState[source];
    if (!st || !Number.isFinite(price)) return;
    st.price = price;
    st.updatedAt = ts;
    const last = st.series[st.series.length - 1];
    if (last && last.t === ts && last.p === price) return;
    st.series.push({ t: ts, p: price });
    pruneExchangeSeries(source, ts);
  }

  function chartThemeOptions() {
    const style = getComputedStyle(document.documentElement);
    const pick = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return {
      layout: {
        background: { type: LightweightCharts.ColorType.Solid, color: pick('--chart-bg', 'rgba(0,0,0,0.22)') },
        textColor: pick('--chart-text', 'rgba(139,149,168,0.9)'),
      },
      grid: {
        vertLines: { color: pick('--chart-grid', 'rgba(255,255,255,0.04)') },
        horzLines: { color: pick('--chart-grid-strong', 'rgba(255,255,255,0.07)') },
      },
      rightPriceScale: { borderColor: pick('--chart-border', 'rgba(255,255,255,0.06)') },
      timeScale: { borderColor: pick('--chart-border', 'rgba(255,255,255,0.06)') },
    };
  }

  function miniChartThemeOptions() {
    const style = getComputedStyle(document.documentElement);
    const pick = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return {
      layout: {
        background: { type: LightweightCharts.ColorType.Solid, color: pick('--mini-chart-bg', 'rgba(0,0,0,0.12)') },
        textColor: pick('--chart-text', 'rgba(139,149,168,0.75)'),
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: pick('--mini-chart-grid', 'rgba(255,255,255,0.05)') },
      },
    };
  }

  function applyChartThemes() {
    if (typeof LightweightCharts === 'undefined') return;
    const mainOpts = chartThemeOptions();
    if (btcChart) {
      btcChart.applyOptions(mainOpts);
    }
    if (btcLineSeries) {
      btcLineSeries.applyOptions({ color: chartLineColor() });
    }
    for (const ex of EXCHANGES) {
      const ui = exchangeUi[ex.id];
      if (ui?.chart) ui.chart.applyOptions(miniChartThemeOptions());
    }
  }

  function initMiniChart(source, container, color) {
    if (!container || typeof LightweightCharts === 'undefined') return null;
    const { createChart } = LightweightCharts;
    const chart = createChart(container, {
      width: container.clientWidth || 280,
      height: 72,
      ...miniChartThemeOptions(),
      layout: {
        ...miniChartThemeOptions().layout,
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontSize: 10,
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.15, bottom: 0.1 },
      },
      timeScale: {
        borderVisible: false,
        visible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Hidden },
      handleScroll: false,
      handleScale: false,
    });
    const lineSeries = chart.addLineSeries({
      color,
      lineWidth: 2,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    return { chart, lineSeries, container };
  }

  function drawMiniChart(source) {
    const ui = exchangeUi[source];
    const st = exchangeState[source];
    if (!ui || !st) return;
    if (!ui.chart && ui.chartHost) {
      const ex = EXCHANGES.find((e) => e.id === source);
      const built = initMiniChart(source, ui.chartHost, ex?.color || chartLineColor());
      if (built) {
        ui.chart = built.chart;
        ui.lineSeries = built.lineSeries;
      }
    }
    if (!ui.chart || !ui.lineSeries) return;
    const points = st.series.filter((p) => p.t >= Date.now() - MINI_CHART_HISTORY_MS);
    if (points.length < 2) return;
    const data = dedupeChartTimes(points.map((p) => ({
      time: Math.floor(p.t / 1000),
      value: p.p,
    })));
    ui.lineSeries.setData(data);
    ui.chart.timeScale().fitContent();
  }

  function scheduleMiniChartDraw(source) {
    const ui = exchangeUi[source];
    if (!ui) return;
    if (ui.chartRaf) return;
    ui.chartRaf = requestAnimationFrame(() => {
      ui.chartRaf = null;
      drawMiniChart(source);
    });
  }

  function renderExchangeCard(source) {
    const ui = exchangeUi[source];
    const st = exchangeState[source];
    const ex = EXCHANGES.find((e) => e.id === source);
    if (!ui || !st || !ex) return;

    if (ui.priceEl) {
      const next = Number.isFinite(st.price) ? `$${D.fmtPrice(st.price)}` : '—';
      if (ui.priceEl.textContent !== next) {
        ui.priceEl.textContent = next;
        flashPrice(ui.priceEl);
      }
    }

    if (ui.statusEl) {
      ui.statusEl.textContent = st.connected ? 'Live' : 'Waiting';
      ui.statusEl.className = `pill pill-sm ${st.connected ? 'on' : 'off'}`;
    }

    if (ui.ageEl) {
      const age = st.updatedAt ? Date.now() - st.updatedAt : null;
      ui.ageEl.textContent = Number.isFinite(age) ? fmtAgeMs(age) : '—';
    }

    if (ui.spreadEl) {
      if (source === 'binance') {
        ui.spreadEl.hidden = true;
      } else {
        ui.spreadEl.hidden = false;
        const ref = exchangeState.binance?.price;
        const spread = fmtSpreadDelta(
          Number.isFinite(st.price) && Number.isFinite(ref) ? st.price - ref : null,
          ref,
        );
        ui.spreadEl.classList.remove('positive', 'negative', 'flat');
        if (!spread) {
          ui.spreadEl.textContent = 'vs Binance —';
          ui.spreadEl.classList.add('flat');
        } else {
          ui.spreadEl.textContent = `vs Binance ${spread.text}`;
          if (Math.abs(spread.delta) < 0.01) ui.spreadEl.classList.add('flat');
          else if (spread.delta > 0) ui.spreadEl.classList.add('positive');
          else ui.spreadEl.classList.add('negative');
        }
      }
    }

    scheduleMiniChartDraw(source);
  }

  function renderAllExchangeCards() {
    for (const ex of EXCHANGES) renderExchangeCard(ex.id);
  }

  function buildExchangeCards() {
    if (!exchangeCardsHost) return;
    exchangeCardsHost.innerHTML = '';
    for (const ex of EXCHANGES) {
      const card = document.createElement('article');
      card.className = 'exchange-feed-card';
      card.dataset.source = ex.id;
      card.innerHTML = `
        <div class="exchange-feed-card-head">
          <span class="exchange-feed-name">${ex.label}</span>
          <div class="exchange-feed-meta">
            <span class="exchange-feed-age" data-role="age">—</span>
            <span class="exchange-feed-spread flat" data-role="spread" hidden>—</span>
            <span class="pill pill-sm off" data-role="status">Waiting</span>
          </div>
        </div>
        <div class="exchange-feed-price num" data-role="price">—</div>
        <div class="exchange-feed-pair">${ex.pair}</div>
        <div class="exchange-mini-chart" data-role="chart"></div>
        <details class="stream-log-details" data-role="log-details">
          <summary class="subsection-label">Stream log</summary>
          <div class="log log-compact" data-role="log"></div>
        </details>
      `;
      const logDetails = card.querySelector('[data-role="log-details"]');
      if (logDetails) logDetails.open = DEBUG;
      exchangeUi[ex.id] = {
        card,
        priceEl: card.querySelector('[data-role="price"]'),
        ageEl: card.querySelector('[data-role="age"]'),
        spreadEl: card.querySelector('[data-role="spread"]'),
        statusEl: card.querySelector('[data-role="status"]'),
        logEl: card.querySelector('[data-role="log"]'),
        chartHost: card.querySelector('[data-role="chart"]'),
        chart: null,
        lineSeries: null,
        chartRaf: null,
      };
      exchangeCardsHost.appendChild(card);
    }
  }

  async function loadExchangeHistories() {
    await Promise.all(EXCHANGES.map(async (ex) => {
      try {
        const resp = await fetch(`/api/btc/history?minutes=5&source=${ex.id}`).then((r) => r.json());
        mergeExchangeHistory(ex.id, resp.history || []);
      } catch (_) {}
      renderExchangeCard(ex.id);
    }));
  }

  function applyExchangeFeedsStatus(feeds) {
    if (!feeds || typeof feeds !== 'object') return;
    for (const ex of EXCHANGES) {
      if (typeof feeds[ex.id] === 'boolean') exchangeState[ex.id].connected = feeds[ex.id];
    }
    renderAllExchangeCards();
  }

  function handleExchangePrice(msg) {
    const source = msg.source;
    if (!exchangeState[source]) return;
    const p = msg.price;
    const ts = msg.timestamp || Date.now();
    pushExchangePoint(source, p, ts);
    exchangeState[source].connected = true;
    renderAllExchangeCards();
    if (DEBUG && exchangeUi[source]?.logEl) {
      prependLog(exchangeUi[source].logEl, `<strong>${D.fmtPrice(p)}</strong> @ ${D.fmtTs(ts)}`);
    }
    if (source === 'binance') {
      pushBtcPoint(p, ts);
      scheduleChartDraw();
      if (beatBtcNow) {
        beatBtcNow.textContent = D.fmtBtcUsd(p);
        flashPrice(beatBtcNow);
      }
      renderBeatPrice();
    }
  }

  function handleExchangeHistory(msg) {
    const source = msg.source;
    if (!exchangeState[source]) return;
    mergeExchangeHistory(source, msg.history);
    renderExchangeCard(source);
    if (source === 'binance') {
      mergeBtcHistory(msg.history);
      scheduleChartDraw();
    }
  }

  function mergeBtcHistory(points) {
    if (!Array.isArray(points)) return;
    for (const pt of points) {
      if (!Number.isFinite(pt?.t) || !Number.isFinite(pt?.p)) continue;
      btcSeries.push({ t: pt.t, p: pt.p });
    }
    btcSeries.sort((a, b) => a.t - b.t);
    pruneBtcSeries();
  }

  function pruneBtcSeries(now = Date.now()) {
    const cutoff = now - CHART_HISTORY_MS;
    while (btcSeries.length && btcSeries[0].t < cutoff) btcSeries.shift();
    if (btcSeries.length > CHART_MAX_POINTS) {
      btcSeries.splice(0, btcSeries.length - CHART_MAX_POINTS);
    }
  }

  function chartVisibleSec() {
    const wm = D.getState().primaryPoly?.windowMinutes;
    if (wm === 5) return 5 * 60;
    if (wm === 15) return 5 * 60;
    return 60;
  }

  function fmtCountdownClock(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function dedupeChartTimes(data) {
    if (!data.length) return data;
    const out = [data[0]];
    for (let i = 1; i < data.length; i++) {
      const pt = data[i];
      const prev = out[out.length - 1];
      if (pt.time === prev.time) prev.value = pt.value;
      else out.push(pt);
    }
    return out;
  }

  function nicePriceRange(min, max, beat) {
    let lo = min;
    let hi = max;
    if (Number.isFinite(beat)) {
      lo = Math.min(lo, beat);
      hi = Math.max(hi, beat);
    }
    const span = hi - lo || Y_TICK_STEP;
    const pad = Math.max(span * 0.06, Y_TICK_STEP * 0.4);
    lo -= pad;
    hi += pad;
    const step = span > 200 ? 50 : Y_TICK_STEP;
    return {
      minValue: Math.floor(lo / step) * step,
      maxValue: Math.ceil(hi / step) * step,
    };
  }

  function initBtcChart() {
    if (!btcChartContainer || typeof LightweightCharts === 'undefined') return;
    const { createChart, LineStyle } = LightweightCharts;

    btcChart = createChart(btcChartContainer, {
      width: btcChartContainer.clientWidth || 640,
      height: btcChartContainer.clientHeight || 240,
      ...chartThemeOptions(),
      layout: {
        ...chartThemeOptions().layout,
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontSize: 11,
      },
      rightPriceScale: {
        ...chartThemeOptions().rightPriceScale,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        ...chartThemeOptions().timeScale,
        timeVisible: true,
        secondsVisible: true,
        fixLeftEdge: false,
        fixRightEdge: false,
        rightOffset: 3,
        tickMarkFormatter: (time) => {
          const d = new Date(Number(time) * 1000);
          return d.toLocaleTimeString(undefined, {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
          });
        },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Hidden,
      },
      handleScroll: false,
      handleScale: false,
    });

    btcLineSeries = btcChart.addLineSeries({
      color: chartLineColor(),
      lineWidth: 2,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
      autoscaleInfoProvider: (original) => {
        const base = original();
        if (!base) return base;
        const beat = D.getState().priceToBeat;
        return {
          priceRange: nicePriceRange(
            base.priceRange.minValue,
            base.priceRange.maxValue,
            beat,
          ),
        };
      },
    });

    if (typeof ResizeObserver !== 'undefined') {
      chartResizeObserver = new ResizeObserver(() => {
        if (!btcChart || !btcChartContainer) return;
        btcChart.applyOptions({
          width: btcChartContainer.clientWidth,
          height: btcChartContainer.clientHeight || 240,
        });
        scheduleChartDraw();
      });
      chartResizeObserver.observe(btcChartContainer);
    } else {
      window.addEventListener('resize', () => {
        if (!btcChart || !btcChartContainer) return;
        btcChart.applyOptions({
          width: btcChartContainer.clientWidth,
          height: btcChartContainer.clientHeight || 240,
        });
        scheduleChartDraw();
      });
    }
  }

  function pushBtcPoint(price, ts = Date.now()) {
    if (!Number.isFinite(price)) return;
    const last = btcSeries[btcSeries.length - 1];
    if (last && last.t === ts && last.p === price) return;
    btcSeries.push({ t: ts, p: price });
    pruneBtcSeries(ts);
  }

  function scheduleChartDraw() {
    if (chartRaf) return;
    chartRaf = requestAnimationFrame(() => {
      chartRaf = null;
      drawBtcChart();
    });
  }

  function drawBtcChart() {
    if (!btcChartContainer) return;
    if (!btcChart) initBtcChart();
    if (!btcChart || !btcLineSeries) return;

    const now = Date.now();
    const visibleMs = chartVisibleSec() * 1000;
    const cutoff = now - CHART_HISTORY_MS;
    const points = btcSeries.filter((p) => p.t >= cutoff);

    if (points.length < 2) return;

    const data = dedupeChartTimes(
      points.map((p) => ({
        time: Math.floor(p.t / 1000),
        value: p.p,
      })),
    );

    btcLineSeries.setData(data);

    const last = points[points.length - 1];
    const beat = D.getState().priceToBeat;
    const { LineStyle } = LightweightCharts;

    if (Number.isFinite(beat)) {
      if (!beatPriceLine) {
        beatPriceLine = btcLineSeries.createPriceLine({
          price: beat,
          color: chartBeatLineColor(),
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'Beat',
        });
      } else {
        beatPriceLine.applyOptions({ price: beat });
      }
    } else if (beatPriceLine) {
      btcLineSeries.removePriceLine(beatPriceLine);
      beatPriceLine = null;
    }

    if (Number.isFinite(last.p)) {
      if (!spotPriceLine) {
        spotPriceLine = btcLineSeries.createPriceLine({
          price: last.p,
          color: chartLineColor(),
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: '',
        });
      } else {
        spotPriceLine.applyOptions({ price: last.p });
      }
    }

    const lastTime = data[data.length - 1].time;
    btcLineSeries.setMarkers([{
      time: lastTime,
      position: 'inBar',
      color: chartLineColor(),
      shape: 'circle',
      size: 0.9,
    }]);

    const visibleFrom = Math.floor((now - visibleMs) / 1000);
    const visibleTo = Math.floor(now / 1000) + 2;
    btcChart.timeScale().setVisibleRange({ from: visibleFrom, to: visibleTo });
  }

  function initFollowLiveToggle() {
    if (!followLiveToggle) return;
    followLiveToggle.checked = D.isFollowLiveWindow();
    followLiveToggle.addEventListener('change', () => {
      D.sendFollowLive(followLiveToggle.checked);
    });
  }

  async function loadBtcHistory() {
    try {
      const resp = await fetch('/api/btc/history?minutes=15').then((r) => r.json());
      mergeBtcHistory(resp.history || D.getState().btcHistory);
      scheduleChartDraw();
    } catch (_) {
      mergeBtcHistory(D.getState().btcHistory);
      scheduleChartDraw();
    }
  }

  function tradePopupClass(trade) {
    const side = String(trade.side || '').toUpperCase();
    const clob = String(trade.clobSide || '').toLowerCase();
    if (clob === 'sell') return 'popup-sell';
    return side === 'NO' ? 'popup-no' : 'popup-yes';
  }

  function showTradePopup(trade) {
    if (!tradePopupHost) return;
    const side = String(trade.side || '—').toUpperCase();
    const el = document.createElement('div');
    el.className = `trade-popup ${tradePopupClass(trade)}`;
    el.textContent = `${side} ${tradeAmountLabel(trade)} @ ${D.fmtPrice(trade.price, 3)}`;
    tradePopupHost.prepend(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    setTimeout(() => {
      el.classList.remove('visible');
      setTimeout(() => el.remove(), 280);
    }, POPUP_MS);
    while (tradePopupHost.children.length > MAX_POPUPS) {
      tradePopupHost.removeChild(tradePopupHost.lastChild);
    }
  }

  function tradeSideClass(trade) {
    const side = String(trade.side || '').toUpperCase();
    const clob = String(trade.clobSide || '').toLowerCase();
    if (clob === 'sell') return 'tape-sell';
    return side === 'NO' ? 'tape-no' : 'tape-yes';
  }

  function tradeAmountLabel(trade) {
    if (Number.isFinite(trade.usdc)) return D.fmtDollars(trade.usdc);
    if (Number.isFinite(trade.size)) return `${D.fmtSize(trade.size)} sh`;
    return '—';
  }

  function appendTradeTapeRow(trade, ts) {
    if (!tradeTape) return;
    const side = String(trade.side || '—').toUpperCase();
    const row = document.createElement('div');
    row.className = `trade-tape-row ${tradeSideClass(trade)}`;
    row.innerHTML = `
      <span class="tape-side">${side}</span>
      <span class="tape-amt num">${tradeAmountLabel(trade)}</span>
      <span class="tape-px num">${D.fmtPrice(trade.price, 3)}</span>
      <span class="tape-ts">${ts}</span>
    `;
    tradeTape.prepend(row);
    while (tradeTape.children.length > MAX_TAPE) tradeTape.removeChild(tradeTape.lastChild);
  }

  function handlePolymarketTrade(msg) {
    const ts = D.fmtTs(msg.ts_ms || msg.timestamp || Date.now());
    appendTradeTapeRow(msg, ts);
    showTradePopup(msg);
    if (!DEBUG) return;
    const side = String(msg.side || '—').toUpperCase();
    prependLog(
      polyLog,
      `<strong>${side}</strong> ${tradeAmountLabel(msg)} @ ${D.fmtPrice(msg.price, 3)} · ${ts}`,
      tradeSideClass(msg).replace('tape-', 'bot-'),
    );
  }

  function prependLog(el, html, cls) {
    if (!el) return;
    const line = document.createElement('div');
    line.className = `line ${cls || ''}`.trim();
    line.innerHTML = html;
    el.prepend(line);
    while (el.children.length > MAX_LOG) el.removeChild(el.lastChild);
  }

  function renderLiveWarning() {
    if (!liveWarning) return;
    const s = D.getState();
    liveWarning.hidden = true;
    liveWarning.classList.remove('gap');
    liveWarning.textContent = '';

    if (s.showingUpcomingOnly) {
      const nextIn = D.fmtCountdown(s.nextStartInMs);
      liveWarning.hidden = false;
      liveWarning.classList.add('gap');
      liveWarning.textContent = nextIn
        ? `No live ${s.selectedPolyMode} market — next window in ${nextIn}. Showing next slot; will auto-switch when it opens.`
        : `No live ${s.selectedPolyMode} market right now — showing next slot. Will auto-switch when it opens.`;
      return;
    }

    if (s.primaryPhase === 'upcoming' && s.hasActiveWindow) {
      liveWarning.hidden = false;
      liveWarning.textContent = `No active ${s.selectedPolyMode} market selected — showing next slot instead of the current live window.`;
    }
  }

  let lastCountdownText = '';

  function pulseCountdown(el) {
    if (!el) return;
    el.classList.remove('countdown-tick');
    void el.offsetWidth;
    el.classList.add('countdown-tick');
  }

  function updateResolutionCountdown() {
    const market = D.getState().primaryPoly;
    const endTime = market?.endTime;
    const windowStart = Number.isFinite(market?.windowStartTime)
      ? market.windowStartTime
      : (Number.isFinite(endTime) && market?.windowMinutes
        ? endTime - market.windowMinutes * 60_000
        : null);
    if (!polyResolution) return;
    if (!Number.isFinite(endTime)) {
      polyResolution.hidden = true;
      lastCountdownText = '';
      return;
    }
    const now = Date.now();
    const remaining = endTime - now;
    polyResolution.hidden = false;
    polyResolution.classList.remove('urgent', 'resolved', 'upcoming', 'live');
    let nextText;
    let ariaLabel;
    if (remaining <= 0) {
      nextText = 'Resolved';
      ariaLabel = 'Market resolved';
      polyResolution.classList.add('resolved');
    } else {
      const windowActive = !Number.isFinite(windowStart) || windowStart <= now;
      if (!windowActive) {
        const untilStart = windowStart - now;
        nextText = fmtCountdownClock(untilStart) || '—';
        ariaLabel = `Upcoming · starts in ${D.fmtCountdown(untilStart) || '…'}`;
        polyResolution.classList.add('upcoming');
      } else {
        nextText = fmtCountdownClock(remaining) || '—';
        ariaLabel = `Live · resolves in ${D.fmtCountdown(remaining) || '…'}`;
        polyResolution.classList.add('live');
        const wm = market?.windowMinutes || 5;
        if (remaining < wm * 60 * 1000) polyResolution.classList.add('urgent');
      }
    }
    polyResolution.textContent = nextText;
    polyResolution.setAttribute('aria-label', ariaLabel);
    if (nextText !== lastCountdownText) {
      pulseCountdown(polyResolution);
      lastCountdownText = nextText;
    }
  }

  function beatSourceLabel(src) {
    if (src === 'binance_snapshot') return 'Binance · window open';
    if (src === 'binance_kline') return 'Binance 1m open · window start';
    return src || '—';
  }

  function renderBeatPrice() {
    const s = D.getState();
    const beat = s.priceToBeat;
    const spot = Number.isFinite(s.chainlinkSpot) ? s.chainlinkSpot : s.btcSpot;

    if (beatPriceValue) {
      beatPriceValue.textContent = Number.isFinite(beat) ? D.fmtBtcUsd(beat) : '—';
    }
    if (beatSource) {
      if (Number.isFinite(beat)) {
        beatSource.textContent = beatSourceLabel(s.priceToBeatSource);
      } else if (Number.isFinite(s.windowStartTime)) {
        const until = s.windowStartTime - Date.now();
        beatSource.textContent = until > 0
          ? `Opens in ${D.fmtCountdown(until) || '…'}`
          : 'Strike loading…';
      } else {
        beatSource.textContent = 'Waiting for market…';
      }
    }
    if (beatBtcNow) {
      beatBtcNow.textContent = Number.isFinite(s.btcSpot) ? D.fmtBtcUsd(s.btcSpot) : '—';
    }
    if (beatChainlinkWrap && beatChainlinkNow) {
      const hasCl = Number.isFinite(s.chainlinkSpot);
      beatChainlinkWrap.hidden = !hasCl;
      if (hasCl) beatChainlinkNow.textContent = D.fmtBtcUsd(s.chainlinkSpot);
    }
    if (!beatDelta) return;
    beatDelta.classList.remove('above', 'below', 'flat');
    if (!Number.isFinite(beat) || !Number.isFinite(spot)) {
      beatDelta.textContent = '—';
      return;
    }
    const diff = spot - beat;
    const abs = Math.abs(diff);
    if (Math.abs(diff) < 0.005) {
      beatDelta.textContent = 'At beat';
      beatDelta.classList.add('flat');
      return;
    }
    const dir = diff > 0 ? 'above' : 'below';
    beatDelta.classList.add(dir);
    const sign = diff > 0 ? '+' : '−';
    beatDelta.textContent = `${sign}${D.fmtBtcUsd(abs)}`;
  }

  function renderPrimary() {
    const s = D.getState();
    const market = s.primaryPoly;
    if (polyMarketTitle) {
      polyMarketTitle.textContent = market?.question || market?.conditionId || 'Waiting for market…';
    }
    updateResolutionCountdown();
    renderBeatPrice();
    renderLiveWarning();
  }

  function flashPrice(el) {
    if (!el) return;
    el.classList.remove('price-flash');
    void el.offsetWidth;
    el.classList.add('price-flash');
  }

  function renderPolyPrices() {
    const { yes, no } = D.resolvedPolyPrices();
    if (polyYesPrice) {
      const next = D.fmtPrice(yes, 3);
      if (polyYesPrice.textContent !== next) {
        polyYesPrice.textContent = next;
        flashPrice(polyYesPrice);
      }
    }
    if (polyNoPrice) {
      const next = D.fmtPrice(no, 3);
      if (polyNoPrice.textContent !== next) {
        polyNoPrice.textContent = next;
        flashPrice(polyNoPrice);
      }
    }
    renderPrimary();
  }

  D.subscribe((msg) => {
    const ts = D.fmtTs(msg.timestamp || Date.now());
    if (msg.source === 'system' && (msg.type === 'init' || msg.type === 'mode_changed' || msg.type === 'status')) {
      renderPrimary();
      if (msg.exchangeFeeds) applyExchangeFeedsStatus(msg.exchangeFeeds);
    }
    if (msg.source === 'polymarket' && msg.type === 'trade') {
      handlePolymarketTrade(msg);
    }
    if (msg.source === 'polymarket' && (msg.type === 'markets' || msg.type === 'price')) {
      renderPolyPrices();
      if (DEBUG && msg.type === 'price') {
        const { yes, no } = D.resolvedPolyPrices();
        const label = msg.market?.question
          ? msg.market.question.slice(0, 48)
          : (msg.market?.conditionId || '').slice(0, 12);
        prependLog(polyLog, `<strong>YES ${D.fmtPrice(yes, 3)}</strong> · NO ${D.fmtPrice(no, 3)} ${label} @ ${ts}`);
      }
    }
    if (EXCHANGES.some((ex) => ex.id === msg.source) && msg.type === 'price') {
      handleExchangePrice(msg);
    }
    if (EXCHANGES.some((ex) => ex.id === msg.source) && msg.type === 'history') {
      handleExchangeHistory(msg);
    }
    if (msg.source === 'signals' && msg.type === 'microstructure') {
      renderMicrostructure(msg);
    }
    if (msg.source === 'signals' && msg.type === 'btc_up_model') {
      renderBtcUpModel(msg);
    }
  });

  setInterval(() => {
    updateResolutionCountdown();
    renderBeatPrice();
    renderLiveWarning();
    renderAllExchangeCards();
    scheduleChartDraw();
  }, 1000);

  window.addEventListener('resize', scheduleChartDraw);
  window.addEventListener('dashboard-theme-change', applyChartThemes);

  initFollowLiveToggle();
  buildExchangeCards();
  buildMicrostructureCards();
  initBtcChart();
  loadBtcHistory();
  loadExchangeHistories();
  loadMicrostructureSnapshot();
  loadBtcUpModelSnapshot();
  renderPrimary();
})();
