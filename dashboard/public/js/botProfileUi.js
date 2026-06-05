/**
 * Shared bot profile form helpers (Bot page + Strategy Lab).
 */
(() => {
  const PROFILE_STORAGE_KEY = 'botProfileDraft';
  const WINDOW_TOTAL_SEC = { 5: 300, 15: 900, 1440: 86400 };

  function parseOptNum(raw) {
    if (raw === '' || raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function readRunDurationFromForm(els) {
    const mode = els.runModeRadios?.().find((r) => r.checked)?.value || 'indefinite';
    const payload = {
      runMode: mode,
      runMarketLimit: parseOptNum(els.runMarketLimit?.value) ?? 10,
      runTimeLimitMinutes: parseOptNum(els.runTimeLimit?.value) ?? 60,
      runUntil: null,
    };
    const untilRaw = els.runUntil?.value;
    if (untilRaw) {
      const parsed = Date.parse(untilRaw);
      if (Number.isFinite(parsed)) payload.runUntil = new Date(parsed).toISOString();
    }
    if (mode === 'markets') {
      payload.runLimit = { mode: 'trades', tradeCount: payload.runMarketLimit };
    } else {
      payload.runLimit = { mode: 'unlimited', tradeCount: null };
    }
    return payload;
  }

  function applyRunDurationToForm(profile, els) {
    if (!profile) return;
    const mode = profile.runMode || (profile.runLimit?.mode === 'trades' ? 'markets' : 'indefinite');
    for (const radio of els.runModeRadios?.() || []) {
      radio.checked = radio.value === mode;
    }
    if (els.runMarketLimit) {
      els.runMarketLimit.value = String(profile.runMarketLimit ?? profile.runLimit?.tradeCount ?? 10);
    }
    if (els.runTimeLimit) {
      els.runTimeLimit.value = String(profile.runTimeLimitMinutes ?? 60);
    }
    if (els.runUntil && profile.runUntil) {
      const d = new Date(profile.runUntil);
      if (Number.isFinite(d.getTime())) {
        const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
        els.runUntil.value = local.toISOString().slice(0, 16);
      }
    } else if (els.runUntil) {
      els.runUntil.value = '';
    }
    syncRunDurationUi(els);
  }

  function syncRunDurationUi(els) {
    const mode = els.runModeRadios?.().find((r) => r.checked)?.value || 'indefinite';
    if (els.runMarketGroup) els.runMarketGroup.classList.toggle('hidden', mode !== 'markets');
    if (els.runTimeGroup) els.runTimeGroup.classList.toggle('hidden', mode !== 'time');
  }

  function formatRunProgressLabel(progress) {
    if (!progress) return '';
    if (progress.label) return progress.label;
    const parts = [];
    if (progress.runMode === 'markets' && progress.marketLimit != null) {
      parts.push(`${progress.marketsTradedCount ?? 0}/${progress.marketLimit} markets`);
    }
    if (progress.runMode === 'time' && Number.isFinite(progress.remainingMs)) {
      parts.push(`${Math.ceil(progress.remainingMs / 60_000)}m remaining`);
    }
    return parts.join(' · ');
  }

  function readProfileFromForm(els) {
    const stopLossMode = els.stopLossMode?.value || 'pct';
    const payload = {
      strategyId: els.strategySelect?.value || undefined,
      marketWindow: els.marketWindowSelect?.value || undefined,
      stopLossPct: null,
      stopLossPrice: null,
      entryMinSeconds: parseOptNum(els.entryMinSeconds?.value),
      entryMaxSeconds: (() => {
        const earliest = parseOptNum(els.entryMaxSeconds?.value);
        if (earliest == null) return null;
        return earliestAfterStartToMaxRemaining(earliest, windowMinutesFromEls(els));
      })(),
      entryMinPrice: parseOptNum(els.entryMinPrice?.value),
      entryMaxPrice: parseOptNum(els.entryMaxPrice?.value),
      takeProfitPrice: parseOptNum(els.takeProfitPrice?.value),
      tradesPerMarket: els.tradesPerMarket?.value === 'multiple' ? 'multiple' : 'single',
      maxTradesPerMarket: parseOptNum(els.maxTradesPerMarket?.value) ?? 1,
      minSecondsBetweenEntries: parseOptNum(els.minSecondsBetweenEntries?.value) ?? 0,
      multiEntryMode: els.multiEntryModeRadios?.().find((r) => r.checked)?.value === 'sequential'
        ? 'sequential'
        : 'simultaneous',
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
    if (els.runModeRadios) {
      Object.assign(payload, readRunDurationFromForm(els));
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
    if (els.runModeRadios) applyRunDurationToForm(profile, els);
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
      const wm = windowMinutesFromEls(els);
      els.entryMaxSeconds.value = profile.entryMaxSeconds != null
        ? String(maxRemainingToEarliestAfterStart(profile.entryMaxSeconds, wm))
        : '';
    }
    if (els.entryMinPrice) {
      els.entryMinPrice.value = profile.entryMinPrice != null ? String(profile.entryMinPrice) : '';
    }
    if (els.entryMaxPrice) {
      els.entryMaxPrice.value = profile.entryMaxPrice != null ? String(profile.entryMaxPrice) : '';
    }
    if (els.takeProfitPrice) {
      els.takeProfitPrice.value = profile.takeProfitPrice != null ? String(profile.takeProfitPrice) : '';
    }
    if (els.maxTradesPerMarket) {
      els.maxTradesPerMarket.value = String(profile.maxTradesPerMarket ?? 1);
    }
    if (els.tradesPerMarket) {
      els.tradesPerMarket.value = profile.tradesPerMarket === 'multiple' ? 'multiple' : 'single';
    }
    if (els.minSecondsBetweenEntries) {
      els.minSecondsBetweenEntries.value = profile.minSecondsBetweenEntries != null
        ? String(profile.minSecondsBetweenEntries)
        : '';
    }
    const entryMode = profile.multiEntryMode === 'sequential' ? 'sequential' : 'simultaneous';
    for (const radio of els.multiEntryModeRadios?.() || []) {
      radio.checked = radio.value === entryMode;
    }
    syncTradesPerMarketUi(els);
    syncStopLossUi(els);
    syncRunLimitCustomVisibility(els);
  }

  function marketWindowMinutes(marketWindow) {
    if (marketWindow === '15m') return 15;
    if (marketWindow === '1d') return 1440;
    return 5;
  }

  function windowMinutesFromEls(els) {
    return marketWindowMinutes(els.marketWindowSelect?.value || '5m');
  }

  function maxRemainingToEarliestAfterStart(maxRemaining, windowMinutes) {
    const total = WINDOW_TOTAL_SEC[windowMinutes] || 300;
    return total - maxRemaining;
  }

  function earliestAfterStartToMaxRemaining(earliestAfterStart, windowMinutes) {
    const total = WINDOW_TOTAL_SEC[windowMinutes] || 300;
    return total - earliestAfterStart;
  }

  function resolveEntryBounds(windowMinutes, rules = {}) {
    const total = WINDOW_TOTAL_SEC[windowMinutes] || 300;
    let maxRemaining;
    if (Number.isFinite(rules.entryMaxSeconds)) {
      maxRemaining = rules.entryMaxSeconds;
    } else if (windowMinutes === 5) maxRemaining = 270;
    else if (windowMinutes === 15) maxRemaining = 840;
    else if (windowMinutes === 1440) maxRemaining = 82800;
    else maxRemaining = total;

    let minRemaining;
    if (Number.isFinite(rules.entryMinSeconds)) {
      minRemaining = rules.entryMinSeconds === 0 ? 0 : total - rules.entryMinSeconds;
    } else if (windowMinutes === 5) minRemaining = 30;
    else if (windowMinutes === 15) minRemaining = 60;
    else if (windowMinutes === 1440) minRemaining = 3600;
    else minRemaining = 0;
    return { minRemaining, maxRemaining };
  }

  function formatEntryWindowBand(windowMinutes, rules = {}) {
    const { minRemaining, maxRemaining } = resolveEntryBounds(windowMinutes, rules);
    const total = WINDOW_TOTAL_SEC[windowMinutes] || 300;
    const earliest = total - maxRemaining;
    const latest = total - minRemaining;
    return `${earliest}–${latest}s after market start`;
  }

  function resolveStopFromProfile(profile = {}, entryPrice = 0.5, strategyStop = null) {
    const floors = [];
    if (Number.isFinite(profile.stopLossPrice) && profile.stopLossPrice > 0) {
      floors.push(profile.stopLossPrice);
    }
    if (Number.isFinite(profile.stopLossPct) && profile.stopLossPct > 0) {
      floors.push(entryPrice * (1 - profile.stopLossPct / 100));
    }
    if (floors.length) return Math.max(...floors);
    if (Number.isFinite(strategyStop) && strategyStop > 0) return strategyStop;
    return Number.isFinite(profile.stopThreshold) ? profile.stopThreshold : 0.45;
  }

  function formatTradingPreview(profile = {}, windowMinutes = 5) {
    const rules = {
      entryMinSeconds: profile.entryMinSeconds,
      entryMaxSeconds: profile.entryMaxSeconds,
    };
    const stop = resolveStopFromProfile(profile);
    const lines = [
      `Entry window: ${formatEntryWindowBand(windowMinutes, rules)}`,
      `Stop loss: YES ≤ ${stop.toFixed(2)}`,
    ];
    if (Number.isFinite(profile.takeProfitPrice)) {
      lines.push(`Take profit: YES ≥ ${profile.takeProfitPrice}`);
    }
    if (profile.tradesPerMarket === 'multiple') {
      const max = profile.maxTradesPerMarket ?? 2;
      const cooldown = profile.minSecondsBetweenEntries > 0
        ? `, ${profile.minSecondsBetweenEntries}s between entries`
        : '';
      const mode = profile.multiEntryMode === 'sequential' ? 'sequential' : 'simultaneous';
      if (mode === 'sequential') {
        lines.push(`Re-entry: up to ${max} entries per window, one at a time${cooldown}`);
      } else {
        lines.push(`Re-entry: up to ${max} open positions per market (simultaneous)${cooldown}`);
      }
    } else {
      lines.push('Re-entry: one trade per market');
    }
    return lines.join(' · ');
  }

  function syncStopLossUi(els) {
    const mode = els.stopLossMode?.value || 'pct';
    const label = els.stopLossValueLabel;
    const slider = els.stopLossSlider;
    const input = els.stopLossValue;
    const valueGroup = input?.closest('.control-group, .lab-field');
    if (valueGroup) valueGroup.classList.toggle('hidden', mode === 'off');
    if (label) {
      if (mode === 'price') label.textContent = 'Stop price (YES)';
      else label.textContent = 'Stop loss %';
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

  function syncTradesPerMarketUi(els) {
    const multiple = els.tradesPerMarket?.value === 'multiple';
    if (els.maxTradesPerMarketGroup) {
      els.maxTradesPerMarketGroup.classList.toggle('hidden', !multiple);
    }
    if (els.minSecondsBetweenEntriesGroup) {
      els.minSecondsBetweenEntriesGroup.classList.toggle('hidden', !multiple);
    }
    if (els.multiEntryModeGroup) {
      els.multiEntryModeGroup.classList.toggle('hidden', !multiple);
    }
    const sequential = els.multiEntryModeRadios?.().find((r) => r.checked)?.value === 'sequential';
    if (els.maxTradesPerMarketLabel) {
      els.maxTradesPerMarketLabel.textContent = sequential
        ? 'Max entries per window'
        : 'Max open positions per market';
    }
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

  function bindTradingControls(els, onChange) {
    const fields = [
      els.stopLossMode,
      els.stopLossValue,
      els.stopLossSlider,
      els.entryMinSeconds,
      els.entryMaxSeconds,
      els.takeProfitPrice,
      els.tradesPerMarket,
      els.maxTradesPerMarket,
      els.minSecondsBetweenEntries,
      ...(els.multiEntryModeRadios?.() || []),
    ].filter(Boolean);
    const notify = () => {
      syncTradesPerMarketUi(els);
      if (typeof onChange === 'function') onChange();
    };
    for (const el of fields) el.addEventListener('input', notify);
    for (const el of fields) el.addEventListener('change', notify);
    bindStopLossControls(els);
  }

  function bindRunDurationControls(els, onChange) {
    const notify = () => { if (typeof onChange === 'function') onChange(); };
    for (const radio of els.runModeRadios?.() || []) {
      radio.addEventListener('change', () => {
        syncRunDurationUi(els);
        notify();
      });
    }
    for (const el of [els.runMarketLimit, els.runTimeLimit, els.runUntil].filter(Boolean)) {
      el.addEventListener('input', notify);
      el.addEventListener('change', notify);
    }
    syncRunDurationUi(els);
  }

  window.BotProfileUi = {
    PROFILE_STORAGE_KEY,
    WINDOW_TOTAL_SEC,
    readProfileFromForm,
    applyProfileToForm,
    selectValueToRunLimit,
    runLimitToSelectValue,
    syncStopLossUi,
    syncRunLimitCustomVisibility,
    syncTradesPerMarketUi,
    readRunDurationFromForm,
    applyRunDurationToForm,
    syncRunDurationUi,
    formatRunProgressLabel,
    bindRunDurationControls,
    bindStopLossControls,
    bindTradingControls,
    formatTradingPreview,
    resolveStopFromProfile,
    saveDraft,
    loadDraft,
  };
})();
