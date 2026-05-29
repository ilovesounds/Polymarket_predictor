(() => {
  const D = window.Dashboard;
  const STORAGE_WINDOW = 'dashboardMarketsWindow';
  const STORAGE_PRIMARY = 'dashboardPrimaryMarketId';

  const marketsMeta = document.getElementById('markets-meta');
  const marketsSelect = document.getElementById('markets-select');
  const marketsList = document.getElementById('markets-list');
  const marketsDetail = document.getElementById('markets-detail');
  const windowTabs = document.querySelectorAll('.window-tab');

  let browseWindow = localStorage.getItem(STORAGE_WINDOW) || '15m';
  let marketRows = [];
  let selectedId = localStorage.getItem(STORAGE_PRIMARY) || null;
  let detailPayload = null;
  let loading = false;

  function polymarketUrl(slug) {
    if (!slug) return null;
    return `https://polymarket.com/event/${slug}`;
  }

  function copyButton(label, value) {
    if (!value) return '';
    const safe = String(value).replace(/"/g, '&quot;');
    return `<button type="button" class="copy-btn" data-copy="${safe}" title="Copy ${label}">${label}</button>`;
  }

  function fmtWindowTimes(m) {
    const start = Number.isFinite(m.windowStartTime)
      ? new Date(m.windowStartTime).toLocaleString()
      : (m.eventStartTime ? new Date(m.eventStartTime).toLocaleString() : '—');
    const end = Number.isFinite(m.endTime)
      ? new Date(m.endTime).toLocaleString()
      : '—';
    return { start, end };
  }

  function renderDetailCard(payload) {
    if (!marketsDetail) return;
    if (!payload?.market) {
      marketsDetail.innerHTML = '<p class="markets-detail-empty">Select a market to view full Gamma details.</p>';
      return;
    }

    const m = payload.market;
    const live = payload.live || {};
    const params = payload.marketParams || {};
    const times = fmtWindowTimes(m);
    const remaining = Number.isFinite(m.endTime) ? m.endTime - Date.now() : NaN;
    const countdown = Number.isFinite(remaining) && remaining > 0
      ? D.fmtCountdown(remaining)
      : 'resolved';
    const yes = live.yesPrice ?? m.outcomePrices?.[0];
    const no = live.noPrice ?? m.outcomePrices?.[1];
    const url = payload.polymarketUrl || polymarketUrl(m.slug);
    const beat = m.priceToBeat;
    const delta = live.btcDelta;
    const deltaPct = Number.isFinite(beat) && Number.isFinite(live.btcSpot) && beat !== 0
      ? ((live.btcSpot - beat) / beat) * 100
      : null;

    marketsDetail.innerHTML = `
      <div class="detail-header">
        <div>
          <span class="detail-window">${D.formatWindowMinutes(m.windowMinutes)}</span>
          <h3 class="detail-title">${m.question || m.conditionId}</h3>
          <p class="detail-countdown">Resolves in <strong>${countdown}</strong></p>
        </div>
        ${url ? `<a class="detail-link" href="${url}" target="_blank" rel="noopener">Open on Polymarket ↗</a>` : ''}
      </div>

      <div class="detail-grid">
        <article class="detail-card">
          <h4>Prices</h4>
          <div class="detail-kv"><span>YES</span><strong class="yes">${D.fmtPrice(yes, 3)}</strong></div>
          <div class="detail-kv"><span>NO</span><strong class="no">${D.fmtPrice(no, 3)}</strong></div>
          <div class="detail-kv"><span>Outcome prices (Gamma)</span><strong>${(m.outcomePrices || []).map((p) => D.fmtPrice(p, 3)).join(' / ') || '—'}</strong></div>
        </article>

        <article class="detail-card">
          <h4>Price to beat</h4>
          <div class="detail-kv"><span>Strike</span><strong>${Number.isFinite(beat) ? D.fmtBtcUsd(beat) : '—'}</strong></div>
          <div class="detail-kv"><span>BTC spot</span><strong>${Number.isFinite(live.btcSpot) ? D.fmtBtcUsd(live.btcSpot) : '—'}</strong></div>
          <div class="detail-kv"><span>Delta</span><strong class="${delta > 0 ? 'yes' : delta < 0 ? 'no' : ''}">${Number.isFinite(delta) ? `${delta >= 0 ? '+' : ''}${D.fmtBtcUsd(delta)}${Number.isFinite(deltaPct) ? ` (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(3)}%)` : ''}` : '—'}</strong></div>
          <div class="detail-kv"><span>Source</span><strong>${m.priceToBeatSource || '—'}</strong></div>
        </article>

        <article class="detail-card">
          <h4>Liquidity & volume</h4>
          <div class="detail-kv"><span>24h volume</span><strong>${Number.isFinite(m.volume24h) ? D.fmtDollars(m.volume24h) : '—'}</strong></div>
          <div class="detail-kv"><span>Liquidity</span><strong>${Number.isFinite(m.liquidity) ? D.fmtDollars(m.liquidity) : '—'}</strong></div>
          <div class="detail-kv"><span>Spread</span><strong>${Number.isFinite(params.spreadCents) ? `${params.spreadCents.toFixed(2)}¢` : '—'}</strong></div>
          <div class="detail-kv"><span>Depth (weaker)</span><strong>${Number.isFinite(params.weakerSideUsd) ? D.fmtDollars(params.weakerSideUsd) : '—'}</strong></div>
        </article>

        <article class="detail-card">
          <h4>Window</h4>
          <div class="detail-kv"><span>Window start</span><strong>${times.start}</strong></div>
          <div class="detail-kv"><span>Resolves</span><strong>${times.end}</strong></div>
          <div class="detail-kv"><span>Event start</span><strong>${m.eventStartTime ? new Date(m.eventStartTime).toLocaleString() : '—'}</strong></div>
          <div class="detail-kv"><span>Status</span><strong>${m.closed ? 'closed' : m.active === false ? 'inactive' : 'active'}</strong></div>
        </article>

        <article class="detail-card detail-card-wide">
          <h4>Identifiers</h4>
          <div class="detail-ids">
            <div class="detail-kv"><span>Condition</span><code>${m.conditionId || '—'}</code> ${copyButton('copy', m.conditionId)}</div>
            <div class="detail-kv"><span>Slug</span><code>${m.slug || '—'}</code> ${copyButton('copy', m.slug)}</div>
            <div class="detail-kv"><span>YES token</span><code>${m.tokenIdYes || '—'}</code> ${copyButton('copy', m.tokenIdYes)}</div>
            <div class="detail-kv"><span>NO token</span><code>${m.tokenIdNo || '—'}</code> ${copyButton('copy', m.tokenIdNo)}</div>
          </div>
        </article>

        ${m.event ? `
        <article class="detail-card detail-card-wide">
          <h4>Event metadata</h4>
          <div class="detail-kv"><span>Title</span><strong>${m.event.title || '—'}</strong></div>
          <div class="detail-kv"><span>Event slug</span><code>${m.event.slug || '—'}</code></div>
          <div class="detail-kv"><span>Event 24h vol</span><strong>${Number.isFinite(m.event.volume24hr) ? D.fmtDollars(m.event.volume24hr) : '—'}</strong></div>
          <div class="detail-kv"><span>Series</span><strong>${m.event.seriesSlug || '—'}</strong></div>
        </article>` : ''}
      </div>
    `;

    marketsDetail.querySelectorAll('.copy-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const text = btn.getAttribute('data-copy');
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = 'copied';
          setTimeout(() => { btn.textContent = 'copy'; }, 1200);
        } catch (_) {}
      });
    });
  }

  function renderMarketList() {
    const now = Date.now();
    if (marketsMeta) {
      marketsMeta.textContent = `${marketRows.length} live · ${browseWindow} · ${D.fmtTs(now)}`;
    }

    if (marketsSelect) {
      marketsSelect.innerHTML = marketRows.length
        ? marketRows.map((m) => {
          const rem = Number.isFinite(m.endTime) ? m.endTime - now : 0;
          const cd = rem > 0 ? D.fmtCountdown(rem) : 'done';
          const label = `${cd} · ${(m.question || m.conditionId || '').slice(0, 72)}`;
          const sel = m.conditionId === selectedId ? ' selected' : '';
          return `<option value="${m.conditionId}"${sel}>${label}</option>`;
        }).join('')
        : '<option value="">No live markets</option>';
      if (selectedId) marketsSelect.value = selectedId;
    }

    if (!marketsList) return;
    if (!marketRows.length) {
      marketsList.innerHTML = '<div class="market-row empty">No active BTC markets for this window.</div>';
      return;
    }

    marketsList.innerHTML = marketRows.map((m) => {
      const rem = Number.isFinite(m.endTime) ? m.endTime - now : NaN;
      const cd = Number.isFinite(rem) && rem > 0 ? D.fmtCountdown(rem) : 'resolved';
      const primary = m.conditionId === selectedId;
      return `<button type="button" class="market-pick${primary ? ' primary' : ''}" data-id="${m.conditionId}">
        ${primary ? '<span class="live-tag">PRIMARY</span>' : ''}
        <span class="market-pick-cd">${cd}</span>
        <span class="market-pick-q">${(m.question || '').slice(0, 90)}</span>
      </button>`;
    }).join('');

    marketsList.querySelectorAll('.market-pick').forEach((btn) => {
      btn.addEventListener('click', () => selectMarket(btn.dataset.id));
    });
  }

  async function loadWindowList(windowKey) {
    if (loading) return;
    loading = true;
    browseWindow = windowKey;
    localStorage.setItem(STORAGE_WINDOW, windowKey);
    try {
      const resp = await fetch(`/api/markets?window=${encodeURIComponent(windowKey)}`);
      const data = await resp.json();
      marketRows = data.markets || [];
      if (data.selectedMarketId) selectedId = data.selectedMarketId;
      renderMarketList();
      if (!selectedId && marketRows[0]) {
        await selectMarket(marketRows[0].conditionId, { skipFetchList: true });
      } else if (selectedId && marketRows.some((m) => m.conditionId === selectedId)) {
        await loadMarketDetails(selectedId);
      } else if (marketRows[0]) {
        await selectMarket(marketRows[0].conditionId, { skipFetchList: true });
      }
    } catch (e) {
      if (marketsMeta) marketsMeta.textContent = `Load failed: ${e.message}`;
    } finally {
      loading = false;
    }
  }

  async function loadMarketDetails(conditionId) {
    if (!conditionId) return;
    try {
      const resp = await fetch(`/api/markets/${encodeURIComponent(conditionId)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      detailPayload = await resp.json();
      renderDetailCard(detailPayload);
    } catch (e) {
      if (marketsDetail) {
        marketsDetail.innerHTML = `<p class="markets-detail-empty">Failed to load details: ${e.message}</p>`;
      }
    }
  }

  async function selectMarket(conditionId, opts = {}) {
    if (!conditionId) return;
    selectedId = conditionId;
    localStorage.setItem(STORAGE_PRIMARY, conditionId);
    renderMarketList();
    try {
      await D.setPrimaryMarket(conditionId);
    } catch (e) {
      console.warn('primary select failed', e.message);
    }
    await loadMarketDetails(conditionId);
    if (!opts.skipFetchList) renderMarketList();
  }

  function setActiveTab(windowKey) {
    windowTabs.forEach((tab) => {
      const active = tab.dataset.window === windowKey;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  windowTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const w = tab.dataset.window;
      if (!w || w === browseWindow) return;
      setActiveTab(w);
      loadWindowList(w);
    });
  });

  if (marketsSelect) {
    marketsSelect.addEventListener('change', () => {
      if (marketsSelect.value) selectMarket(marketsSelect.value);
    });
  }

  D.subscribe((msg) => {
    if (msg.source === 'polymarket' && msg.type === 'market_details') {
      if (msg.market?.conditionId === selectedId) {
        detailPayload = msg;
        renderDetailCard(msg);
      }
    }
    if (msg.source === 'polymarket' && msg.type === 'market_selected') {
      if (msg.conditionId) {
        selectedId = msg.conditionId;
        localStorage.setItem(STORAGE_PRIMARY, selectedId);
        renderMarketList();
      }
    }
    if (msg.source === 'polymarket' && msg.type === 'price' && msg.market?.conditionId === selectedId && detailPayload?.market) {
      detailPayload.live = {
        ...detailPayload.live,
        yesPrice: msg.yesPrice ?? detailPayload.live?.yesPrice,
        noPrice: msg.noPrice ?? detailPayload.live?.noPrice,
      };
      const s = D.getState();
      if (Number.isFinite(s.btcSpot)) {
        detailPayload.live.btcSpot = s.btcSpot;
        if (Number.isFinite(detailPayload.market.priceToBeat)) {
          detailPayload.live.btcDelta = s.btcSpot - detailPayload.market.priceToBeat;
        }
      }
      renderDetailCard(detailPayload);
    }
  });

  setInterval(() => {
    renderMarketList();
    if (detailPayload) renderDetailCard(detailPayload);
  }, 1000);

  setActiveTab(browseWindow);
  selectedId = localStorage.getItem(STORAGE_PRIMARY) || selectedId;
  loadWindowList(browseWindow);
})();
