/**
 * Shared bet sizing controls (Strategy Lab + Bot page).
 */
(() => {
  function getRadios(name = 'sizing-mode') {
    return [...document.querySelectorAll(`input[name="${name}"]`)];
  }

  function getSelectedMode(name = 'sizing-mode') {
    const checked = getRadios(name).find((r) => r.checked);
    return checked?.value || 'compound';
  }

  function setSelectedMode(mode, name = 'sizing-mode') {
    getRadios(name).forEach((r) => { r.checked = r.value === mode; });
  }

  function updatePanels(panels, mode = getSelectedMode()) {
    Object.entries(panels).forEach(([key, el]) => {
      if (!el) return;
      el.classList.toggle('hidden', key !== mode);
    });
  }

  function readSizingFromForm({ fixedBetInput, betPercentInput, kellySlider, name = 'sizing-mode' } = {}) {
    const mode = getSelectedMode(name);
    const payload = { sizingMode: mode };
    if (fixedBetInput) {
      payload.fixedBetUsd = Number(fixedBetInput.value || 5);
    }
    if (betPercentInput) {
      payload.betPercent = Number(betPercentInput.value || 25);
    }
    if (kellySlider) {
      const raw = Number(kellySlider.value || 8);
      payload.kellyFractionCap = raw > 1 ? raw / 100 : raw;
    }
    return payload;
  }

  function applySizingToForm(preset = {}, { fixedBetInput, betPercentInput, kellySlider, panels, name = 'sizing-mode' } = {}) {
    if (preset.sizingMode) setSelectedMode(preset.sizingMode, name);
    if (Number.isFinite(preset.fixedBetUsd) && fixedBetInput) {
      fixedBetInput.value = preset.fixedBetUsd;
    }
    if (Number.isFinite(preset.betPercent) && betPercentInput) {
      betPercentInput.value = preset.betPercent;
    }
    if (Number.isFinite(preset.kellyFractionCap) && kellySlider) {
      const pct = preset.kellyFractionCap <= 1
        ? preset.kellyFractionCap * 100
        : preset.kellyFractionCap;
      kellySlider.value = Number(pct).toFixed(1);
    }
    if (panels) updatePanels(panels, preset.sizingMode || getSelectedMode(name));
  }

  function sizingLabel(mode, preset = {}) {
    if (mode === 'fixed') return `Fixed $${preset.fixedBetUsd ?? '?'}`;
    if (mode === 'percent') return `Percent ${preset.betPercent ?? '?'}%`;
    if (mode === 'amount_cap') {
      return `Cap $${preset.fixedBetUsd ?? '?'} / ${preset.betPercent ?? '?'}%`;
    }
    if (mode === 'kelly') {
      const cap = Number.isFinite(preset.kellyFractionCap)
        ? `${(preset.kellyFractionCap * 100).toFixed(0)}% cap`
        : 'Kelly';
      return `Kelly (${cap})`;
    }
    return 'Compound (100% bankroll)';
  }

  function renderPreview(el, preview) {
    if (!el || !preview) return;
    el.textContent = preview.label || preview;
  }

  function bindSizingControls({ panels, betPercentSlider, betPercentInput, kellySlider, onChange, name = 'sizing-mode' } = {}) {
    const sync = () => {
      updatePanels(panels, getSelectedMode(name));
      if (onChange) onChange();
    };
    getRadios(name).forEach((r) => r.addEventListener('change', sync));
    if (betPercentSlider && betPercentInput) {
      betPercentSlider.addEventListener('input', () => {
        betPercentInput.value = betPercentSlider.value;
        if (onChange) onChange();
      });
      betPercentInput.addEventListener('input', () => {
        betPercentSlider.value = betPercentInput.value;
        if (onChange) onChange();
      });
    }
    if (kellySlider) kellySlider.addEventListener('input', () => { if (onChange) onChange(); });
    sync();
  }

  window.SizingUi = {
    getRadios,
    getSelectedMode,
    setSelectedMode,
    updatePanels,
    readSizingFromForm,
    applySizingToForm,
    sizingLabel,
    renderPreview,
    bindSizingControls,
  };
})();
