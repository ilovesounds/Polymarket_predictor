(() => {
  const D = window.Dashboard;
  const MAX_TRADE_LOG = 40;

  const cashEl = document.getElementById('portfolio-cash');
  const startingEl = document.getElementById('portfolio-starting');
  const realizedEl = document.getElementById('portfolio-realized');
  const unrealizedEl = document.getElementById('portfolio-unrealized');
  const positionValueEl = document.getElementById('portfolio-position-value');
  const equityEl = document.getElementById('portfolio-equity');
  const roiEl = document.getElementById('portfolio-roi');
  const openCountEl = document.getElementById('portfolio-open-count');
  const positionsBody = document.getElementById('portfolio-positions-body');
  const tradeLog = document.getElementById('portfolio-trade-log');
  const tradeCountEl = document.getElementById('portfolio-trade-count');
  const profileSelect = document.getElementById('portfolio-profile-select');

  const seenTradeKeys = new Set();
  let portfolioLoaded = false;
  let activeProfileId = 'default';

  function tradeKey(entry) {
    return `${entry.tradeId || ''}:${entry.type}:${entry.timestamp}`;
  }

  function fmtRoi(value) {
    if (!Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
  }

  function fmtPnlPct(value) {
    if (!Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
  }

  function renderSummary(portfolio) {
    if (cashEl) {
      cashEl.textContent = D.fmtDollars(portfolio.cash);
      cashEl.className = 'bankroll-stat-value';
    }
    if (startingEl) {
      const envStart = portfolio.envStartingCash;
      const extra = Number.isFinite(portfolio.netCashDelta) && portfolio.netCashDelta !== 0
        ? ` (${portfolio.netCashDelta > 0 ? '+' : ''}${D.fmtDollars(portfolio.netCashDelta)} adj.)`
        : '';
      const envHint = Number.isFinite(envStart) && envStart !== portfolio.startingCash
        ? ` · env $${envStart.toFixed(2)}`
        : '';
      startingEl.textContent = `${D.fmtDollars(portfolio.startingCash)}${extra}${envHint}`;
    }
    if (realizedEl) {
      realizedEl.textContent = D.fmtDollars(portfolio.realizedPnlTotal);
      realizedEl.className = `metric-value ${D.pnlClass(portfolio.realizedPnlTotal)}`.trim();
    }
    if (unrealizedEl) {
      unrealizedEl.textContent = D.fmtDollars(portfolio.totalUnrealizedPnl);
      unrealizedEl.className = `metric-value ${D.pnlClass(portfolio.totalUnrealizedPnl)}`.trim();
    }
    if (positionValueEl) {
      positionValueEl.textContent = D.fmtDollars(portfolio.openPositionValue);
      positionValueEl.className = 'bankroll-stat-value';
    }
    if (equityEl) {
      equityEl.textContent = D.fmtDollars(portfolio.portfolio ?? portfolio.totalEquity);
      equityEl.className = 'bankroll-hero-value';
    }
    if (roiEl) {
      roiEl.textContent = fmtRoi(portfolio.roiPct);
      roiEl.className = `bankroll-roi-badge ${D.pnlClass(portfolio.roiPct)}`.trim();
    }
    if (openCountEl) {
      openCountEl.textContent = String(portfolio.openPositionCount ?? portfolio.openPositions?.length ?? 0);
      openCountEl.className = 'bankroll-stat-value';
    }
  }

  function renderPositions(openPositions = []) {
    if (!positionsBody) return;
    if (!portfolioLoaded) {
      positionsBody.innerHTML = '<tr class="empty-row"><td colspan="9">Loading positions…</td></tr>';
      return;
    }
    if (!openPositions.length) {
      positionsBody.innerHTML = '<tr class="empty-row"><td colspan="9">No open positions.</td></tr>';
      return;
    }
    positionsBody.innerHTML = openPositions.map((pos) => {
      const market = pos.question || pos.marketId || '—';
      const window = pos.windowLabel || (pos.windowMinutes ? `${pos.windowMinutes}m` : '—');
      const entryTag = Number.isFinite(pos.entryIndex) && pos.entryIndex > 1
        ? `#${pos.entryIndex} · `
        : '';
      const side = String(pos.side || 'YES').toUpperCase();
      const upnl = pos.unrealizedPnl;
      const upnlPct = pos.unrealizedPnlPct;
      return `<tr>
        <td class="col-market">${market}</td>
        <td>${entryTag}${window}</td>
        <td><span class="side-pill side-${side.toLowerCase()}">${side}</span></td>
        <td>${D.fmtSize(pos.shares)}</td>
        <td>${D.fmtPrice(pos.entryPrice, 2)}</td>
        <td>${D.fmtPrice(pos.currentPrice, 2)}</td>
        <td>${D.fmtDollars(pos.currentValue)}</td>
        <td class="${D.pnlClass(upnl)}">${Number.isFinite(upnl) ? D.fmtDollars(upnl) : '—'}</td>
        <td class="${D.pnlClass(upnlPct)}">${fmtPnlPct(upnlPct)}</td>
      </tr>`;
    }).join('');
  }

  function appendTradeLine(entry, { prepend = true } = {}) {
    if (!tradeLog || !entry) return;
    const key = tradeKey(entry);
    if (seenTradeKeys.has(key)) return;
    seenTradeKeys.add(key);

    const line = document.createElement('div');
    const type = entry.type || 'event';
    line.className = `line portfolio-trade ${type === 'entry' ? 'bot-entry' : type === 'exit' ? 'bot-exit' : 'bot-check'}`;
    const text = entry.logLine || entry.detail || `${type} ${entry.tradeId || ''}`.trim();
    const reasonTag = entry.exitReason === 'resolution'
      ? ' <span class="trade-reason">resolved</span>'
      : entry.exitReason
        ? ` <span class="trade-reason">${String(entry.exitReason).replace(/_/g, ' ')}</span>`
        : '';
    line.innerHTML = `<span class="trade-type">${type}</span> ${text}${reasonTag} <span class="trade-ts">@ ${D.fmtTs(entry.timestamp)}</span>`;
    if (prepend) tradeLog.prepend(line);
    else tradeLog.appendChild(line);
    while (tradeLog.children.length > MAX_TRADE_LOG) tradeLog.removeChild(tradeLog.lastChild);
  }

  function renderTradeHistory(tradeHistory = [], { replace = false } = {}) {
    if (replace) {
      seenTradeKeys.clear();
      if (tradeLog) tradeLog.innerHTML = '';
    }
    const ordered = [...tradeHistory];
    for (const entry of ordered) appendTradeLine(entry, { prepend: false });
    if (tradeCountEl) {
      tradeCountEl.textContent = `${tradeHistory.length} trade${tradeHistory.length === 1 ? '' : 's'}`;
    }
  }

  function renderPortfolioView(portfolio, { mergeHistory = false } = {}) {
    if (!portfolio) return;
    portfolioLoaded = true;
    renderSummary(portfolio);
    renderPositions(portfolio.openPositions || []);
    if (!mergeHistory) {
      renderTradeHistory(portfolio.tradeHistory || [], { replace: true });
    }
  }

  async function loadPortfolio(profileId = activeProfileId) {
    try {
      const q = profileId ? `?profileId=${encodeURIComponent(profileId)}` : '';
      const resp = await fetch(`/api/portfolio${q}`).then((r) => r.json());
      D.applyPortfolioSnapshot(resp);
      renderPortfolioView(D.getPortfolio());
    } catch (_) {
      portfolioLoaded = true;
      renderPositions([]);
    }
  }

  async function loadProfileOptions() {
    if (!profileSelect) return;
    try {
      const resp = await fetch('/api/bot/profiles').then((r) => r.json());
      activeProfileId = resp.activeProfileId || 'default';
      profileSelect.innerHTML = (resp.profiles || [])
        .map((p) => `<option value="${p.id}">${p.name}</option>`)
        .join('');
      profileSelect.value = activeProfileId;
    } catch (_) {}
  }

  profileSelect?.addEventListener('change', () => {
    activeProfileId = profileSelect.value;
    loadPortfolio(activeProfileId);
  });

  D.subscribePortfolio((portfolio) => {
    renderPortfolioView(portfolio, { mergeHistory: true });
  });

  D.subscribe((msg) => {
    if (msg.source === 'system' && msg.type === 'hello' && msg.portfolio) {
      D.applyPortfolioSnapshot(msg.portfolio);
      renderPortfolioView(D.getPortfolio());
    }

    if (msg.source === 'bot' && msg.type === 'portfolio_snapshot') {
      D.applyPortfolioSnapshot({
        mode: msg.mode,
        cash: msg.cash ?? msg.bankroll,
        startingCash: msg.startingCash ?? msg.startingBankroll,
        netCashDelta: msg.netCashDelta,
        envStartingCash: msg.envStartingCash,
        portfolio: msg.portfolio ?? msg.totalEquity,
        realizedPnlTotal: msg.realizedPnlTotal,
        openPositions: msg.openPositions,
        openPositionValue: msg.openPositionValue,
        totalUnrealizedPnl: msg.totalUnrealizedPnl,
        totalEquity: msg.totalEquity,
        roiPct: msg.roiPct,
        tradeHistory: msg.tradeHistory ?? D.getPortfolio().tradeHistory,
      });
    }

    if (msg.source === 'bot' && (msg.type === 'entry' || msg.type === 'exit')) {
      appendTradeLine({
        type: msg.type,
        tradeId: msg.tradeId,
        logLine: msg.logLine || msg.detail,
        exitReason: msg.exitReason,
        timestamp: msg.timestamp,
      }, { prepend: true });
      if (tradeCountEl) {
        const count = Math.max(
          D.getPortfolio().tradeHistory.length,
          tradeLog?.children.length || 0,
        );
        tradeCountEl.textContent = `${count} trade${count === 1 ? '' : 's'}`;
      }
    }
  });

  loadProfileOptions().then(() => loadPortfolio(activeProfileId));

  window.DashboardCashAdjust?.wire({
    amountInputId: 'portfolio-cash-amount',
    addBtnId: 'portfolio-cash-add',
    removeBtnId: 'portfolio-cash-remove',
    baselineCheckboxId: 'portfolio-cash-update-baseline',
    statusElId: 'portfolio-cash-status',
  });
})();
