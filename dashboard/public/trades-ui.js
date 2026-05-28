/**
 * Polymarket live trade tape + toast popups (YES/NO buys).
 */
window.PolyTradeTape = function initPolyTradeTape({
  tapeEl,
  popupHostEl,
  maxTrades = 100,
  popupMs = 2500,
  tapeThrottleMs = 50,
  maxTapePerSec = 20,
} = {}) {
  const trades = [];
  let pendingTape = [];
  let tapeFlushTimer = null;
  let lastTapeFlush = 0;
  let tapeBurst = 0;
  let tapeBurstWindow = 0;

  function fmtTsMs(ts) {
    const d = new Date(ts);
    const hasMs = Number.isFinite(ts) && (ts % 1000) !== 0;
    const opts = { hour12: false };
    if (hasMs) opts.fractionalSecondDigits = 3;
    return d.toLocaleTimeString(undefined, opts);
  }

  function fmtUsd(v) {
    if (!Number.isFinite(v)) return '$—';
    if (v >= 100) return `$${v.toFixed(0)}`;
    return `$${v.toFixed(2)}`;
  }

  function fmtPrice(v) {
    if (!Number.isFinite(v)) return '—';
    return v >= 1 ? v.toFixed(2) : v.toFixed(3);
  }

  function tradePopupLabel(msg) {
    const usdc = Number.isFinite(msg.usdc) ? msg.usdc : (msg.size * msg.price);
    const sign = String(msg.clobSide || '').toUpperCase() === 'SELL' ? '−' : '+';
    return `${msg.side} ${sign}${fmtUsd(usdc)} @ ${fmtPrice(msg.price)}`;
  }

  function renderTapeRow(msg) {
    const usdc = Number.isFinite(msg.usdc) ? msg.usdc : (msg.size * msg.price);
    const sign = String(msg.clobSide || '').toUpperCase() === 'SELL' ? '−' : '+';
    const sideCls = msg.side === 'YES' ? 'tape-yes' : 'tape-no';
    const actionCls = String(msg.clobSide || '').toUpperCase() === 'SELL' ? 'tape-sell' : 'tape-buy';
    const ts = msg.ts_ms || msg.timestamp || Date.now();
    return `<div class="trade-tape-row ${sideCls} ${actionCls}">
      <span class="tape-side">${msg.side}</span>
      <span class="tape-amt">${sign}${fmtUsd(usdc)}</span>
      <span class="tape-px">@ ${fmtPrice(msg.price)}</span>
      <span class="tape-ts">${fmtTsMs(ts)}</span>
    </div>`;
  }

  function flushTape() {
    if (!tapeEl || !pendingTape.length) return;
    const frag = pendingTape.map(renderTapeRow).join('');
    pendingTape = [];
    tapeEl.insertAdjacentHTML('afterbegin', frag);
    while (tapeEl.children.length > maxTrades) {
      tapeEl.removeChild(tapeEl.lastChild);
    }
    lastTapeFlush = Date.now();
    tapeBurst = 0;
  }

  function scheduleTapeFlush() {
    const now = Date.now();
    if (now - tapeBurstWindow >= 1000) {
      tapeBurstWindow = now;
      tapeBurst = 0;
    }
    tapeBurst += 1;

    const schedule = () => {
      if (tapeFlushTimer) return;
      tapeFlushTimer = setTimeout(() => {
        tapeFlushTimer = null;
        flushTape();
      }, tapeThrottleMs);
    };

    if (tapeBurst > maxTapePerSec) {
      schedule();
      return;
    }

    if (now - lastTapeFlush >= tapeThrottleMs) {
      flushTape();
      return;
    }
    schedule();
  }

  function showPopup(msg) {
    if (!popupHostEl) return;
    const el = document.createElement('div');
    const sideCls = msg.side === 'YES' ? 'popup-yes' : 'popup-no';
    const sell = String(msg.clobSide || '').toUpperCase() === 'SELL';
    el.className = `trade-popup ${sideCls}${sell ? ' popup-sell' : ''}`;
    el.textContent = tradePopupLabel(msg);
    popupHostEl.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    setTimeout(() => {
      el.classList.remove('visible');
      setTimeout(() => el.remove(), 320);
    }, popupMs);
    while (popupHostEl.children.length > 8) {
      popupHostEl.removeChild(popupHostEl.firstChild);
    }
  }

  function onTrade(msg) {
    if (!msg || (msg.side !== 'YES' && msg.side !== 'NO')) return;
    const ts = msg.ts_ms || msg.timestamp || Date.now();
    const normalized = { ...msg, ts_ms: ts };
    trades.unshift(normalized);
    if (trades.length > maxTrades) trades.pop();

    showPopup(normalized);
    pendingTape.push(normalized);
    scheduleTapeFlush();
  }

  function clear() {
    trades.length = 0;
    pendingTape = [];
    if (tapeEl) tapeEl.innerHTML = '';
    if (popupHostEl) popupHostEl.innerHTML = '';
  }

  return { onTrade, clear, trades };
};
