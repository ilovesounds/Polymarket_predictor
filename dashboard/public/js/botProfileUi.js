/**
 * Shared bot profile form helpers (Bot page + Strategy Lab).
 */
(() => {
  const PROFILE_STORAGE_KEY = 'botProfileDraft';

  function parseOptNum(raw) {
    if (raw === '' || raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function readProfileFromForm(els) {
    const stopLossMode = els.stopLossMode?.value || 'pct';
    const payload = {
      strategyId: els.strategySelect?.value || undefined,
      marketWindow: els.marketWindowSelect?.value || undefined,
      stopLossPct: null,
      stopLossPrice: null,
      entryMinSeconds: parseOptNum(els.entryMinSeconds?.value),
      entryMaxSeconds: parseOptNum(els.entryMaxSeconds?.value),
      entryMinPrice: parseOptNum(els.entryMinPrice?.value),
      entryMaxPrice: parseOptNum(els.entryMaxPrice?.value),
      maxTradesPerMarket: parseOptNum(els.maxTradesPerMarket?.value) ?? 1,
    };
    if (stopLossMode === 'price') {
      payload.stopLossPrice = parseOptNum(els.stopLossValue?.value);
    } else if (stopLossMode === 'pct') {
      payload.stopLossPct = parseOptNum(els.stopLossValue?.value);
    }
    if (els.runLimitSelect) {
      payload.runLimit = selectValueToRunLimit(
        els.runLimitSelect.value,
        els.runCustomTrades?.value
      );
    }
    return payload;
  }

  function selectValueToRunLimit(value, customTrades) {
    if (value === 'unlimited') return { mode: 'unlimited' };
    if (value === 'end_of_day') return { mode: 'end_of_day' };
    if (value === 'trades_4') return { mode: 'trades', tradeCount: 4 };
    if (value === 'trades_11') return { mode: 'trades', tradeCount: 11 };
    const n = Math.max(1, Math.min(500, parseInt(customTrades || '11', 10) || 11));
    return { mode: 'trades', tradeCount: n };
  }

  function runLimitToSelectValue(runLimit) {
    if (!runLimit || runLimit.mode === 'unlimited') return 'unlimited';
    if (runLimit.mode === 'end_of_day') return 'end_of_day';
    if (runLimit.mode === 'trades') {
      if (runLimit.tradeCount === 4) return 'trades_4';
      if (runLimit.tradeCount === 11) return 'trades_11';
      return 'trades_custom';
    }
    return 'unlimited';
  }

  function applyProfileToForm(profile, els) {
    if (!profile) return;
    if (els.strategySelect && profile.strategyId) {
      els.strategySelect.value = profile.strategyId;
    }
    if (els.marketWindowSelect && profile.marketWindow) {
      els.marketWindowSelect.value = profile.marketWindow;
    }
    if (els.runLimitSelect && profile.runLimit) {
      els.runLimitSelect.value = runLimitToSelectValue(profile.runLimit);
      if (profile.runLimit.mode === 'trades' && els.runCustomTrades) {
        els.runCustomTrades.value = String(profile.runLimit.tradeCount || 11);
      }
    }
    if (Number.isFinite(profile.stopLossPrice)) {
      if (els.stopLossMode) els.stopLossMode.value = 'price';
      if (els.stopLossValue) els.stopLossValue.value = String(profile.stopLossPrice);
    } else if (Number.isFinite(profile.stopLossPct)) {
      if (els.stopLossMode) els.stopLossMode.value = 'pct';
      if (els.stopLossValue) els.stopLossValue.value = String(profile.stopLossPct);
    } else if (els.stopLossValue) {
      els.stopLossValue.value = '10';
    }
    if (els.entryMinSeconds) {
      els.entryMinSeconds.value = profile.entryMinSeconds != null ? String(profile.entryMinSeconds) : '';
    }
    if (els.entryMaxSeconds) {
      els.entryMaxSeconds.value = profile.entryMaxSeconds != null ? String(profile.entryMaxSeconds) : '';
    }
    if (els.entryMinPrice) {
      els.entryMinPrice.value = profile.entryMinPrice != null ? String(profile.entryMinPrice) : '';
    }
    if (els.entryMaxPrice) {
      els.entryMaxPrice.value = profile.entryMaxPrice != null ? String(profile.entryMaxPrice) : '';
    }
    if (els.maxTradesPerMarket) {
      els.maxTradesPerMarket.value = String(profile.maxTradesPerMarket ?? 1);
    }
    syncStopLossUi(els);
    syncRunLimitCustomVisibility(els);
  }

  function syncStopLossUi(els) {
    const mode = els.stopLossMode?.value || 'pct';
    const label = els.stopLossValueLabel;
    const slider = els.stopLossSlider;
    const input = els.stopLossValue;
    const valueGroup = input?.closest('.control-group, .lab-field');
    if (valueGroup) valueGroup.classList.toggle('hidden', mode === 'off');
    if (label) {
      label.textContent = mode === 'price' ? 'Stop price (YES)' : 'Stop loss %';
    }
    if (slider && input) {
      if (mode === 'price') {
        slider.min = '0.05';
        slider.max = '0.95';
        slider.step = '0.01';
        if (!Number.isFinite(parseFloat(input.value)) || parseFloat(input.value) > 1) {
          input.value = '0.45';
        }
        slider.value = input.value;
      } else {
        slider.min = '1';
        slider.max = '50';
        slider.step = '1';
        if (!Number.isFinite(parseFloat(input.value)) || parseFloat(input.value) <= 1) {
          input.value = '10';
        }
        slider.value = input.value;
      }
    }
  }

  function syncRunLimitCustomVisibility(els) {
    const show = els.runLimitSelect?.value === 'trades_custom';
    if (els.runCustomGroup) els.runCustomGroup.classList.toggle('hidden', !show);
  }

  function bindStopLossControls(els) {
    const sync = () => {
      syncStopLossUi(els);
      if (els.stopLossSlider && els.stopLossValue && document.activeElement === els.stopLossSlider) {
        els.stopLossValue.value = els.stopLossSlider.value;
      }
    };
    els.stopLossMode?.addEventListener('change', sync);
    els.stopLossSlider?.addEventListener('input', () => {
      if (els.stopLossValue) els.stopLossValue.value = els.stopLossSlider.value;
    });
    els.stopLossValue?.addEventListener('input', () => {
      if (els.stopLossSlider) els.stopLossSlider.value = els.stopLossValue.value;
    });
    sync();
  }

  function saveDraft(profile) {
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    } catch (_) {}
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  window.BotProfileUi = {
    PROFILE_STORAGE_KEY,
    readProfileFromForm,
    applyProfileToForm,
    selectValueToRunLimit,
    runLimitToSelectValue,
    syncStopLossUi,
    syncRunLimitCustomVisibility,
    bindStopLossControls,
    saveDraft,
    loadDraft,
  };
})();
