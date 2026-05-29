(() => {
  const D = window.Dashboard;
  const MAX_LOG = 80;
  const SPARK_LEN = 120;

  const polyYesPrice = document.getElementById('poly-yes-price');
  const polyNoPrice = document.getElementById('poly-no-price');
  const binancePrice = document.getElementById('binance-price');
  const polyMeta = document.getElementById('poly-meta');
  const polyMarketTitle = document.getElementById('poly-market-title');
  const polyResolution = document.getElementById('poly-resolution');
  const binanceMeta = document.getElementById('binance-meta');
  const polyLog = document.getElementById('poly-log');
  const binanceLog = document.getElementById('binance-log');

  const beatPriceValue = document.getElementById('beat-price-value');
  const beatSource = document.getElementById('beat-source');
  const beatBtcNow = document.getElementById('beat-btc-now');
  const beatChainlinkWrap = document.getElementById('beat-chainlink-wrap');
  const beatChainlinkNow = document.getElementById('beat-chainlink-now');
  const beatDelta = document.getElementById('beat-delta');

  const polySpark = document.getElementById('poly-spark');
  const binanceSpark = document.getElementById('binance-spark');
  const polyCtx = polySpark?.getContext('2d');
  const binanceCtx = binanceSpark?.getContext('2d');

  const polyHistory = [];
  const binanceHistory = [];
  const tradeTape = document.getElementById('trade-tape');
  const tradePopupHost = document.getElementById('trade-popup-host');
  const MAX_TAPE = 80;
  const MAX_POPUPS = 5;
  const POPUP_MS = 2800;

  function tradeSideClass(trade) {
    const side = String(trade.side || '').toUpperCase();
    const clob = String(trade.clobSide || '').toLowerCase();
    if (clob === 'sell') return 'tape-sell';
    return side === 'NO' ? 'tape-no' : 'tape-yes';
  }

  function tradePopupClass(trade) {
    const side = String(trade.side || '').toUpperCase();
    const clob = String(trade.clobSide || '').toLowerCase();
    if (clob === 'sell') return 'popup-sell';
    return side === 'NO' ? 'popup-no' : 'popup-yes';
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
      <span class="tape-amt">${tradeAmountLabel(trade)}</span>
      <span class="tape-px">${D.fmtPrice(trade.price, 3)}</span>
      <span class="tape-ts">${ts}</span>
    `;
    tradeTape.prepend(row);
    while (tradeTape.children.length > MAX_TAPE) tradeTape.removeChild(tradeTape.lastChild);
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
      setTimeout(() => el.remove(), 250);
    }, POPUP_MS);
    while (tradePopupHost.children.length > MAX_POPUPS) {
      tradePopupHost.removeChild(tradePopupHost.lastChild);
    }
  }

  function handlePolymarketTrade(msg) {
    const ts = D.fmtTs(msg.ts_ms || msg.timestamp || Date.now());
    appendTradeTapeRow(msg, ts);
    showTradePopup(msg);
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

  function drawSpark(ctx, canvas, history, color) {
    if (!ctx || !canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (history.length < 2) return;
    const min = Math.min(...history);
    const max = Math.max(...history);
    const range = max - min || 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    history.forEach((v, i) => {
      const x = (i / (history.length - 1)) * (w - 4) + 2;
      const y = h - 4 - ((v - min) / range) * (h - 8);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function pushHistory(arr, value) {
    arr.push(value);
    if (arr.length > SPARK_LEN) arr.shift();
  }

  function updateResolutionCountdown() {
    const endTime = D.getState().primaryPoly?.endTime;
    if (!polyResolution) return;
    if (!Number.isFinite(endTime)) {
      polyResolution.hidden = true;
      return;
    }
    const remaining = endTime - Date.now();
    polyResolution.hidden = false;
    polyResolution.classList.remove('urgent', 'resolved');
    if (remaining <= 0) {
      polyResolution.textContent = 'Resolved';
      polyResolution.classList.add('resolved');
      return;
    }
    polyResolution.textContent = `Resolves in ${D.fmtCountdown(remaining)}`;
    if (remaining < 5 * 60 * 1000) polyResolution.classList.add('urgent');
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
    const pct = (diff / beat) * 100;
    const abs = Math.abs(diff);
    if (Math.abs(pct) < 0.0005) {
      beatDelta.textContent = 'At beat price';
      beatDelta.classList.add('flat');
      return;
    }
    const dir = diff > 0 ? 'above' : 'below';
    beatDelta.classList.add(dir);
    const sign = diff > 0 ? '+' : '−';
    beatDelta.textContent = `${sign}${D.fmtBtcUsd(abs)} (${sign}${Math.abs(pct).toFixed(3)}%) · ${dir} beat`;
  }

  function renderPrimary() {
    const s = D.getState();
    const market = s.primaryPoly;
    if (polyMarketTitle) {
      polyMarketTitle.textContent = market?.question || market?.conditionId || 'Waiting for market…';
    }
    updateResolutionCountdown();
    renderBeatPrice();
  }

  function renderPolyPrices(ts) {
    const s = D.getState();
    const { yes, no } = D.resolvedPolyPrices();
    if (polyYesPrice) polyYesPrice.textContent = D.fmtPrice(yes, 3);
    if (polyNoPrice) polyNoPrice.textContent = D.fmtPrice(no, 3);
    const wm = s.primaryPoly?.windowMinutes
      ? D.formatWindowMinutes(s.primaryPoly.windowMinutes)
      : s.selectedPolyMode;
    const via = s.lastPolyVia ? ` · ${s.lastPolyVia}` : '';
    const src = s.feedSource ? ` · ${s.feedSource}` : '';
    if (polyMeta) polyMeta.textContent = `${wm}${via}${src} · ${ts}`;
    const sparkSource = Number.isFinite(yes) ? yes : no;
    if (Number.isFinite(sparkSource)) {
      pushHistory(polyHistory, sparkSource);
      drawSpark(polyCtx, polySpark, polyHistory, '#22c55e');
    }
    renderPrimary();
  }

  D.subscribe((msg) => {
    const ts = D.fmtTs(msg.timestamp || Date.now());
    if (msg.source === 'system' && (msg.type === 'init' || msg.type === 'mode_changed' || msg.type === 'status')) {
      renderPrimary();
    }
    if (msg.source === 'polymarket' && msg.type === 'trade') {
      handlePolymarketTrade(msg);
    }
    if (msg.source === 'polymarket' && (msg.type === 'markets' || msg.type === 'price')) {
      renderPolyPrices(ts);
      if (msg.type === 'price') {
        const { yes, no } = D.resolvedPolyPrices();
        const label = msg.market?.question
          ? msg.market.question.slice(0, 48)
          : (msg.market?.conditionId || '').slice(0, 12);
        prependLog(polyLog, `<strong>YES ${D.fmtPrice(yes, 3)}</strong> · NO ${D.fmtPrice(no, 3)} ${label} @ ${ts}`);
      }
    }
    if (msg.source === 'binance' && msg.type === 'price') {
      const p = msg.price;
      if (binancePrice) binancePrice.textContent = `$${D.fmtPrice(p)}`;
      if (binanceMeta) binanceMeta.textContent = `updated ${ts}`;
      pushHistory(binanceHistory, p);
      drawSpark(binanceCtx, binanceSpark, binanceHistory, '#3b82f6');
      prependLog(binanceLog, `<strong>${D.fmtPrice(p)}</strong> @ ${ts}`);
      renderBeatPrice();
    }
  });

  setInterval(() => {
    updateResolutionCountdown();
    renderBeatPrice();
  }, 1000);

  renderPrimary();
})();
