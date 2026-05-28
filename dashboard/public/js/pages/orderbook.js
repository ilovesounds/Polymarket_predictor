(() => {
  const D = window.Dashboard;

  const polyMarketTitle = document.getElementById('poly-market-title');
  const polyResolution = document.getElementById('poly-resolution');
  const obYesBestBid = document.getElementById('ob-yes-best-bid');
  const obYesBestAsk = document.getElementById('ob-yes-best-ask');
  const obNoBestBid = document.getElementById('ob-no-best-bid');
  const obNoBestAsk = document.getElementById('ob-no-best-ask');
  const obYesDepth = document.getElementById('ob-yes-depth');
  const obNoDepth = document.getElementById('ob-no-depth');
  const obYesBidLadder = document.getElementById('ob-yes-bid-ladder');
  const obYesAskLadder = document.getElementById('ob-yes-ask-ladder');
  const obNoBidLadder = document.getElementById('ob-no-bid-ladder');
  const obNoAskLadder = document.getElementById('ob-no-ask-ladder');
  const obUpdated = document.getElementById('ob-updated');

  function renderLadder(el, levels = [], prefix = '') {
    if (!el) return;
    if (!levels.length) {
      el.innerHTML = '<div class="ladder-empty">—</div>';
      return;
    }
    el.innerHTML = levels
      .map((row) => `<div>${prefix}${D.fmtPrice(row.price, 3)} × ${D.fmtSize(row.size)}</div>`)
      .join('');
  }

  function renderSide(ladder, side) {
    const bids = ladder?.bid?.ladder || [];
    const asks = ladder?.ask?.ladder || [];
    return { bids, asks, bestBid: ladder?.bid?.best?.price, bestAsk: ladder?.ask?.best?.price, depth: (ladder?.bid?.depthTop5 || 0) + (ladder?.ask?.depthTop5 || 0) };
  }

  function renderOrderbook(msg) {
    const yes = renderSide(msg?.yes);
    const no = renderSide(msg?.no);
    if (obYesBestBid) obYesBestBid.textContent = D.fmtPrice(yes.bestBid, 3);
    if (obYesBestAsk) obYesBestAsk.textContent = D.fmtPrice(yes.bestAsk, 3);
    if (obNoBestBid) obNoBestBid.textContent = D.fmtPrice(no.bestBid, 3);
    if (obNoBestAsk) obNoBestAsk.textContent = D.fmtPrice(no.bestAsk, 3);
    if (obYesDepth) obYesDepth.textContent = D.fmtSize(yes.depth);
    if (obNoDepth) obNoDepth.textContent = D.fmtSize(no.depth);
    renderLadder(obYesBidLadder, yes.bids, 'B ');
    renderLadder(obYesAskLadder, yes.asks, 'A ');
    renderLadder(obNoBidLadder, no.bids, 'B ');
    renderLadder(obNoAskLadder, no.asks, 'A ');
    if (obUpdated) obUpdated.textContent = `Updated ${D.fmtTs(msg.timestamp || Date.now())}${msg.via ? ` · ${msg.via}` : ''}`;
  }

  function updateHeader() {
    const market = D.getState().primaryPoly;
    if (polyMarketTitle) {
      polyMarketTitle.textContent = market?.question || market?.conditionId || 'Waiting for market…';
    }
    if (!polyResolution) return;
    const endTime = market?.endTime;
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

  D.subscribe((msg) => {
    if (msg.source === 'polymarket' && msg.type === 'orderbook') renderOrderbook(msg);
    if (msg.source === 'polymarket' && (msg.type === 'markets' || msg.type === 'price')) updateHeader();
    if (msg.source === 'system' && msg.type === 'init') {
      if (D.getState().lastOrderbook) renderOrderbook(D.getState().lastOrderbook);
      updateHeader();
    }
  });

  if (D.getState().lastOrderbook) renderOrderbook(D.getState().lastOrderbook);
  updateHeader();
  setInterval(updateHeader, 1000);
})();
