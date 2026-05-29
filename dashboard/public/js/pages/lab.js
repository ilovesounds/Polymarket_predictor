/**
 * Strategy Lab page — live microstructure params + no-code / code builders.
 */
(() => {
  const D = window.Dashboard;
  const P = window.BotProfileUi;
  const S = window.SizingUi;
  if (!D) return;

  const LOCAL_PRESET_KEY = 'strategyLabPresetDraft';

  const labProfileEls = {
    strategySelect: document.getElementById('lab-strategy-select'),
    stopLossMode: document.getElementById('lab-stop-loss-mode'),
    stopLossValue: document.getElementById('lab-stop-loss-value'),
    stopLossSlider: document.getElementById('lab-stop-loss-slider'),
    stopLossValueLabel: document.getElementById('lab-stop-loss-value-label'),
    entryMinSeconds: document.getElementById('lab-entry-min-seconds'),
    entryMaxSeconds: document.getElementById('lab-entry-max-seconds'),
    takeProfitPrice: document.getElementById('lab-take-profit-price'),
    tradesPerMarket: document.getElementById('lab-trades-per-market'),
    maxTradesPerMarket: document.getElementById('lab-max-trades-market'),
    maxTradesPerMarketGroup: document.getElementById('lab-max-trades-group'),
    maxTradesPerMarketLabel: document.getElementById('lab-max-trades-label'),
    minSecondsBetweenEntries: document.getElementById('lab-min-entry-cooldown'),
    minSecondsBetweenEntriesGroup: document.getElementById('lab-entry-cooldown-group'),
    multiEntryModeGroup: document.getElementById('lab-multi-entry-mode-group'),
    multiEntryModeRadios: () => Array.from(document.querySelectorAll('input[name="lab-multi-entry-mode"]')),
    tradingPreview: document.getElementById('lab-trading-preview'),
  };

  function readLabBotProfile() {
    const payload = P.readProfileFromForm(labProfileEls);
    if (labProfileEls.stopLossMode?.value === 'off') {
      payload.stopLossPct = null;
      payload.stopLossPrice = null;
    }
    return payload;
  }

  function refreshLabTradingPreview() {
    if (!labProfileEls.tradingPreview) return;
    const wm = D.getState().polyMode === '15m' ? 15 : D.getState().polyMode === '1d' ? 1440 : 5;
    labProfileEls.tradingPreview.textContent = P.formatTradingPreview(readLabBotProfile(), wm);
  }

  const els = {
    marketLabel: document.getElementById('lab-market-label'),
    metrics: document.getElementById('lab-metrics'),
    gateStatus: document.getElementById('lab-gate-status'),
    activePreset: document.getElementById('lab-active-preset'),
    gateModePill: document.getElementById('lab-gate-mode'),
    form: document.getElementById('lab-preset-form'),
    presetName: document.getElementById('preset-name'),
    gateMode: document.getElementById('gate-mode'),
    presetList: document.getElementById('lab-preset-list'),
    formStatus: document.getElementById('lab-form-status'),
    codeTemplate: document.getElementById('lab-code-template'),
  };

  const sliders = {
    maxSpreadCents: document.getElementById('max-spread'),
    minDepthUsd: document.getElementById('min-depth'),
    minVolume24h: document.getElementById('min-volume'),
    maxImbalanceAbs: document.getElementById('max-imbalance'),
    maxSlippagePct: document.getElementById('max-slippage'),
    maxPositionPctOfLiquidity: document.getElementById('max-pos-pct'),
    kellyFractionCap: document.getElementById('kelly-fraction-cap'),
  };

  const outputs = {
    maxSpreadCents: document.getElementById('out-max-spread'),
    minDepthUsd: document.getElementById('out-min-depth'),
    minVolume24h: document.getElementById('out-min-volume'),
    maxImbalanceAbs: document.getElementById('out-max-imbalance'),
    maxSlippagePct: document.getElementById('out-max-slippage'),
    maxPositionPctOfLiquidity: document.getElementById('out-max-pos-pct'),
    kellyFractionCap: document.getElementById('out-kelly-cap'),
  };

  const sizingPanels = {
    fixed: document.getElementById('sizing-panel-fixed'),
    percent: document.getElementById('sizing-panel-percent'),
    kelly: document.getElementById('sizing-panel-kelly'),
    compound: document.getElementById('sizing-panel-compound'),
  };
  const fixedBetInput = document.getElementById('fixed-bet-usd');
  const betPercentSlider = document.getElementById('bet-percent');
  const betPercentInput = document.getElementById('bet-percent-input');
  const betPercentOutput = document.getElementById('out-bet-percent');
  const sizingPreviewEl = document.getElementById('lab-sizing-preview');
  const sizingRadios = () => S?.getRadios('sizing-mode') || [];

  let lastParams = null;
  let lastGate = null;
  let lastPreset = null;

  const CODE_TEMPLATE = `/**
 * Custom strategy stub — Strategy Lab export.
 * Wire into signals/strategies_runtime.js when ready.
 *
 * ctx.params fields:
 *   bidAskSpreadCents, weakerSideUsd, marketDepthUsd, volume24h,
 *   orderbookImbalance (-1..1), slippagePct, mid, betSizeUsdc
 */
function decide(ctx) {
  const { params, yesPrice, bankroll } = ctx;
  if (!params) return { entryEligible: false, reason: 'no market params' };

  if (params.bidAskSpreadCents > 5) {
    return { entryEligible: false, reason: 'spread too wide' };
  }
  if (params.weakerSideUsd < 1000) {
    return { entryEligible: false, reason: 'thin book' };
  }
  if (params.slippagePct != null && params.slippagePct > 2) {
    return { entryEligible: false, reason: 'slippage too high' };
  }

  const entryEligible = yesPrice >= 0.5;
  return {
    entryEligible,
    reason: entryEligible ? 'YES >= 0.50 + microstructure OK' : 'YES below 0.50',
    stop: 0.45,
  };
}

module.exports = { id: 'lab_custom', label: 'Lab custom', decide };
`;

  function fmtUsd(v) {
    if (!Number.isFinite(v)) return '—';
    return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }

  function fmtPct(v, digits = 2) {
    if (!Number.isFinite(v)) return '—';
    return `${v.toFixed(digits)}%`;
  }

  function fmtCents(v) {
    if (!Number.isFinite(v)) return '—';
    return `${v.toFixed(1)}¢`;
  }

  function fmtImbalance(v) {
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(3);
  }

  function metricClass(ok) {
    if (ok === true) return 'metric-ok';
    if (ok === false) return 'metric-bad';
    return 'metric-neutral';
  }

  function evaluateMetric(key, value, thresholds) {
    if (!Number.isFinite(value)) return null;
    switch (key) {
      case 'spread':
        return value <= (thresholds?.maxSpreadCents ?? 5);
      case 'depth':
        return value >= (thresholds?.minDepthUsd ?? 1000);
      case 'volume':
        if (!(thresholds?.minVolume24h > 0)) return true;
        return value >= thresholds.minVolume24h;
      case 'imbalance':
        return Math.abs(value) <= (thresholds?.maxImbalanceAbs ?? 0.8);
      case 'slippage':
        return value <= (thresholds?.maxSlippagePct ?? 2);
      default:
        return null;
    }
  }

  function getSelectedSizingMode() {
    return S?.getSelectedMode('sizing-mode') || 'compound';
  }

  async function refreshSizingPreview() {
    if (!sizingPreviewEl) return;
    const bankroll = D.getPortfolio()?.cash;
    if (!Number.isFinite(bankroll)) return;
    const mode = getSelectedSizingMode();
    const pct = Number(betPercentInput?.value || 25);
    const fixed = Number(fixedBetInput?.value || 5);
    let bet = bankroll;
    if (mode === 'percent') bet = Math.min(bankroll, bankroll * (pct / 100));
    else if (mode === 'fixed') bet = Math.min(fixed, bankroll);
    else if (mode === 'kelly') bet = Math.min(bankroll * 0.08, bankroll);
    S.renderPreview(sizingPreviewEl, {
      label: `Next bet ≈ $${bet.toFixed(2)} (${bankroll > 0 ? ((bet / bankroll) * 100).toFixed(1) : 0}% of $${bankroll.toFixed(2)})`,
    });
  }

  function readFormPreset() {
    return {
      name: els.presetName.value.trim() || 'Untitled preset',
      maxSpreadCents: Number(sliders.maxSpreadCents.value),
      minDepthUsd: Number(sliders.minDepthUsd.value),
      minVolume24h: Number(sliders.minVolume24h.value),
      maxImbalanceAbs: Number(sliders.maxImbalanceAbs.value),
      maxSlippagePct: Number(sliders.maxSlippagePct.value),
      maxPositionPctOfLiquidity: Number(sliders.maxPositionPctOfLiquidity.value),
      gateMode: els.gateMode.value,
      ticksFromMid: 3,
      ...S.readSizingFromForm({
        fixedBetInput,
        betPercentInput,
        kellySlider: sliders.kellyFractionCap,
      }),
    };
  }

  function updateSizingPanels(mode = getSelectedSizingMode()) {
    S.updatePanels(sizingPanels, mode);
    if (betPercentOutput && betPercentInput) betPercentOutput.textContent = betPercentInput.value;
    refreshSizingPreview();
  }

  function applyPresetToForm(preset = {}) {
    if (preset.name) els.presetName.value = preset.name;
    if (Number.isFinite(preset.maxSpreadCents)) sliders.maxSpreadCents.value = preset.maxSpreadCents;
    if (Number.isFinite(preset.minDepthUsd)) sliders.minDepthUsd.value = preset.minDepthUsd;
    if (Number.isFinite(preset.minVolume24h)) sliders.minVolume24h.value = preset.minVolume24h;
    if (Number.isFinite(preset.maxImbalanceAbs)) sliders.maxImbalanceAbs.value = preset.maxImbalanceAbs;
    if (Number.isFinite(preset.maxSlippagePct)) sliders.maxSlippagePct.value = preset.maxSlippagePct;
    if (Number.isFinite(preset.maxPositionPctOfLiquidity)) {
      sliders.maxPositionPctOfLiquidity.value = preset.maxPositionPctOfLiquidity;
    }
    if (preset.gateMode) els.gateMode.value = preset.gateMode;
    if (preset.sizingMode) {
      S.applySizingToForm(preset, {
        fixedBetInput,
        betPercentInput,
        kellySlider: sliders.kellyFractionCap,
        panels: sizingPanels,
      });
    } else {
      updateSizingPanels(getSelectedSizingMode());
    }
    if (Number.isFinite(preset.fixedBetUsd) && fixedBetInput) {
      fixedBetInput.value = preset.fixedBetUsd;
    }
    if (Number.isFinite(preset.betPercent) && betPercentInput) {
      betPercentInput.value = preset.betPercent;
      if (betPercentSlider) betPercentSlider.value = preset.betPercent;
    }
    if (Number.isFinite(preset.kellyFractionCap) && sliders.kellyFractionCap) {
      sliders.kellyFractionCap.value = (preset.kellyFractionCap * 100).toFixed(1);
    }
    updateSizingPanels(preset.sizingMode || getSelectedSizingMode());
    syncSliderOutputs();
    updateCodeTemplateFromForm();
  }

  function syncSliderOutputs() {
    Object.keys(sliders).forEach((key) => {
      const out = outputs[key];
      if (!out || !sliders[key]) return;
      out.textContent = key === 'kellyFractionCap'
        ? sliders[key].value
        : sliders[key].value;
    });
  }

  function sizingLabel(mode, preset = {}) {
    return S.sizingLabel(mode, preset);
  }

  function updateCodeTemplateFromForm() {
    const p = readFormPreset();
    els.codeTemplate.value = CODE_TEMPLATE
      .replace('params.bidAskSpreadCents > 5', `params.bidAskSpreadCents > ${p.maxSpreadCents}`)
      .replace('params.weakerSideUsd < 1000', `params.weakerSideUsd < ${p.minDepthUsd}`)
      .replace('params.slippagePct > 2', `params.slippagePct > ${p.maxSlippagePct}`);
  }

  function renderMetrics(params, gate, preset) {
    if (!params) {
      els.metrics.innerHTML = '<p class="lab-lead">No parameters yet — start the dashboard feeds or bot.</p>';
      return;
    }

    const t = gate?.thresholds || preset || readFormPreset();
    const cards = [
      {
        key: 'spread',
        label: 'Bid-ask spread',
        value: fmtCents(params.bidAskSpreadCents),
        sub: `Mid ${D.fmtPrice(params.mid, 3)}`,
        ok: evaluateMetric('spread', params.bidAskSpreadCents, t),
      },
      {
        key: 'depth',
        label: 'Market depth (weaker side)',
        value: fmtUsd(params.weakerSideUsd),
        sub: `Total ${fmtUsd(params.marketDepthUsd)} · ${params.ticksFromMid || 3} ticks`,
        ok: evaluateMetric('depth', params.weakerSideUsd, t),
      },
      {
        key: 'volume',
        label: '24h volume',
        value: fmtUsd(params.volume24h),
        sub: params.volume24hSource || 'unknown',
        ok: evaluateMetric('volume', params.volume24h, t),
      },
      {
        key: 'imbalance',
        label: 'Orderbook imbalance',
        value: fmtImbalance(params.orderbookImbalance),
        sub: '−1 ask-heavy · +1 bid-heavy',
        ok: evaluateMetric('imbalance', params.orderbookImbalance, t),
      },
      {
        key: 'slippage',
        label: 'Slippage estimate',
        value: fmtPct(params.slippagePct),
        sub: `Bet ${fmtUsd(params.betSizeUsdc)} · fill ${D.fmtPrice(params.slippageFillPrice, 3)}`,
        ok: evaluateMetric('slippage', params.slippagePct, t),
      },
    ];

    els.metrics.innerHTML = cards.map((c) => `
      <article class="metric-card lab-metric ${metricClass(c.ok)}">
        <span class="metric-label">${c.label}</span>
        <span class="metric-value">${c.value}</span>
        <span class="lab-metric-sub">${c.sub}</span>
      </article>
    `).join('');

    if (gate) {
      const cls = gate.passed ? 'ok' : 'bad';
      const items = [...(gate.blocks || []), ...(gate.warnings || [])];
      els.gateStatus.className = `lab-gate-status ${cls}`;
      els.gateStatus.innerHTML = items.length
        ? `<strong>Gate (${gate.gateMode})</strong><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`
        : `<strong>Gate (${gate.gateMode})</strong> All checks passed.`;
    }
  }

  function renderMarketLabel(market) {
    if (!market?.question) {
      els.marketLabel.textContent = 'Waiting for primary market…';
      return;
    }
    const w = D.formatWindowMinutes(market.windowMinutes);
    const id = market.conditionId ? `${market.conditionId.slice(0, 8)}…` : '';
    els.marketLabel.textContent = `${w} · ${id} · ${market.question}`;
  }

  function renderActivePreset(preset) {
    lastPreset = preset;
    const sizing = preset?.sizingMode ? ` · ${sizingLabel(preset.sizingMode, preset)}` : '';
    els.activePreset.textContent = `${preset?.name || 'Environment defaults'}${sizing}`;
    const mode = preset?.gateMode || 'warn';
    els.gateModePill.textContent = mode;
    els.gateModePill.className = `pill ${mode === 'block' ? 'warn' : mode === 'off' ? 'off' : 'on'}`;
  }

  function setFormStatus(msg, kind = 'info') {
    els.formStatus.textContent = msg;
    els.formStatus.className = `lab-form-status ${kind}`;
  }

  function renderLabStrategies(strategies = [], current) {
    const sel = labProfileEls.strategySelect;
    if (!sel || !strategies.length) return;
    sel.innerHTML = strategies.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
    sel.value = current || 'deterministic_yes_50';
  }

  async function loadBotProfileFromServer() {
    try {
      const resp = await fetch('/api/bot/profile').then((r) => r.json());
      if (resp.strategies) renderLabStrategies(resp.strategies, resp.profile?.strategyId);
      if (resp.profile) {
        P.applyProfileToForm(resp.profile, labProfileEls);
        refreshLabTradingPreview();
      }
    } catch (_) {}
  }

  async function loadPresetsFromServer() {
    try {
      const resp = await fetch('/api/lab/presets').then((r) => r.json());
      if (resp.active) renderActivePreset(resp.active);
      renderPresetList(resp.presets || []);
      if (resp.defaults && !localStorage.getItem(LOCAL_PRESET_KEY)) {
        applyPresetToForm({ ...resp.defaults, name: 'New preset' });
      }
      if (resp.sizingDefaults && fixedBetInput && !fixedBetInput.value) {
        fixedBetInput.value = resp.sizingDefaults.fixedBetUsd ?? 5;
      }
    } catch (e) {
      setFormStatus(`Could not load presets: ${e.message}`, 'error');
    }
  }

  function renderPresetList(presets) {
    if (!presets.length) {
      els.presetList.innerHTML = '<li class="muted">No server presets yet</li>';
      return;
    }
    els.presetList.innerHTML = presets.map((p) => `
      <li>
        <button type="button" class="lab-preset-load" data-id="${p.id}">${p.name}</button>
        <button type="button" class="lab-preset-apply" data-id="${p.id}">Apply</button>
      </li>
    `).join('');

    els.presetList.querySelectorAll('.lab-preset-load').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = presets.find((p) => p.id === btn.dataset.id);
        if (preset) applyPresetToForm(preset);
      });
    });
    els.presetList.querySelectorAll('.lab-preset-apply').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await D.postJson('/api/lab/preset/apply', { id: btn.dataset.id, botProfile: readLabBotProfile() });
          setFormStatus('Preset + bot profile applied.', 'ok');
          await loadPresetsFromServer();
        } catch (e) {
          setFormStatus(e.message, 'error');
        }
      });
    });
  }

  function handleParamsMessage(msg) {
    if (msg.type !== 'params') return;
    lastParams = msg.params;
    lastGate = msg.gate;
    if (msg.market) renderMarketLabel(msg.market);
    if (msg.preset) renderActivePreset(msg.preset);
    renderMetrics(lastParams, lastGate, lastPreset);
  }

  Object.values(sliders).forEach((input) => {
    input?.addEventListener('input', () => {
      syncSliderOutputs();
      updateCodeTemplateFromForm();
      if (lastParams) renderMetrics(lastParams, lastGate, readFormPreset());
    });
  });

  fixedBetInput?.addEventListener('input', () => {
    refreshSizingPreview();
    if (lastParams) renderMetrics(lastParams, lastGate, readFormPreset());
  });

  S.bindSizingControls({
    panels: sizingPanels,
    betPercentSlider,
    betPercentInput,
    kellySlider: sliders.kellyFractionCap,
    onChange: () => {
      if (lastParams) renderMetrics(lastParams, lastGate, readFormPreset());
      refreshSizingPreview();
    },
  });

  document.getElementById('btn-save-local')?.addEventListener('click', () => {
    const draft = readFormPreset();
    localStorage.setItem(LOCAL_PRESET_KEY, JSON.stringify(draft));
    setFormStatus('Saved draft to browser localStorage.', 'ok');
  });

  document.getElementById('btn-save-server')?.addEventListener('click', async () => {
    try {
      const preset = readFormPreset();
      await D.postJson('/api/lab/preset', preset);
      setFormStatus('Preset saved on server.', 'ok');
      await loadPresetsFromServer();
    } catch (e) {
      setFormStatus(e.message, 'error');
    }
  });

  document.getElementById('btn-apply-bot')?.addEventListener('click', async () => {
    try {
      const preset = readFormPreset();
      const botProfile = readLabBotProfile();
      const resp = await D.postJson('/api/lab/preset', { ...preset, apply: true, botProfile });
      await D.postJson('/api/bot/profile', botProfile);
      renderActivePreset(resp.active);
      if (resp.profile) P.applyProfileToForm(resp.profile, labProfileEls);
      setFormStatus('Lab preset + bot profile applied (start bot from Bot page).', 'ok');
      await loadPresetsFromServer();
    } catch (e) {
      setFormStatus(e.message, 'error');
    }
  });

  document.getElementById('btn-copy-code')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.codeTemplate.value);
      setFormStatus('Code copied.', 'ok');
    } catch (_) {
      setFormStatus('Copy failed — select text manually.', 'error');
    }
  });

  document.getElementById('btn-download-code')?.addEventListener('click', () => {
    const blob = new Blob([els.codeTemplate.value], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lab-strategy.js';
    a.click();
    URL.revokeObjectURL(url);
    setFormStatus('Downloaded lab-strategy.js', 'ok');
  });

  D.subscribe((msg) => {
    if (msg.source === 'lab' && msg.type === 'params') handleParamsMessage(msg);
    if (msg.source === 'lab' && msg.type === 'preset_applied') {
      renderActivePreset(msg.preset);
      if (msg.profile) P.applyProfileToForm(msg.profile, labProfileEls);
      setFormStatus(`Active preset: ${msg.preset?.name}`, 'ok');
    }
    if (msg.source === 'polymarket' && msg.type === 'markets') {
      const primary = D.getState().primaryPoly;
      if (primary) renderMarketLabel(primary);
    }
  });

  async function init() {
    els.codeTemplate.value = CODE_TEMPLATE;
    syncSliderOutputs();
    updateSizingPanels();

    const localDraft = localStorage.getItem(LOCAL_PRESET_KEY);
    if (localDraft) {
      try { applyPresetToForm(JSON.parse(localDraft)); } catch (_) {}
    }

    P.bindTradingControls(labProfileEls, refreshLabTradingPreview);
    await loadPresetsFromServer();
    await loadBotProfileFromServer();
    refreshLabTradingPreview();

    try {
      const snap = await fetch('/api/lab/params').then((r) => r.json());
      if (snap?.params) handleParamsMessage(snap);
      if (snap?.market) renderMarketLabel(snap.market);
      if (snap?.preset) renderActivePreset(snap.preset);
    } catch (_) {}

    const primary = D.getState().primaryPoly;
    if (primary) renderMarketLabel(primary);
  }

  init();
})();
