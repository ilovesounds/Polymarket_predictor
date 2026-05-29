/**
 * Wire add/remove cash controls (paper mode).
 */
(() => {
  function wireCashAdjust({
    amountInputId,
    addBtnId,
    removeBtnId,
    baselineCheckboxId,
    statusElId,
  }) {
    const D = window.Dashboard;
    const amountInput = document.getElementById(amountInputId);
    const addBtn = document.getElementById(addBtnId);
    const removeBtn = document.getElementById(removeBtnId);
    const baselineCheckbox = baselineCheckboxId
      ? document.getElementById(baselineCheckboxId)
      : null;
    const statusEl = statusElId ? document.getElementById(statusElId) : null;

    function setStatus(text, isError = false) {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.classList.toggle('cash-adjust-error', Boolean(isError));
    }

    async function submit(action) {
      const amount = parseFloat(amountInput?.value || '');
      if (!Number.isFinite(amount) || amount <= 0) {
        setStatus('Enter a positive amount', true);
        return;
      }
      setStatus('Updating…');
      if (addBtn) addBtn.disabled = true;
      if (removeBtn) removeBtn.disabled = true;
      try {
        const resp = await D.postJson('/api/portfolio/cash', {
          action,
          amount,
          updateBaseline: Boolean(baselineCheckbox?.checked),
        });
        if (!resp.ok) {
          setStatus(resp.error || 'Adjustment failed', true);
          return;
        }
        D.applyPortfolioSnapshot(resp.portfolio);
        if (amountInput) amountInput.value = '';
        const note = resp.botSyncNote ? ` ${resp.botSyncNote}` : '';
        setStatus(
          `${action === 'add' ? 'Added' : 'Removed'} $${amount.toFixed(2)}.${note}`,
          false
        );
      } catch (err) {
        let msg = err.message || 'Request failed';
        try {
          const parsed = JSON.parse(msg);
          if (parsed.error) msg = parsed.error;
        } catch (_) { /* use raw message */ }
        setStatus(msg, true);
      } finally {
        if (addBtn) addBtn.disabled = false;
        if (removeBtn) removeBtn.disabled = false;
      }
    }

    addBtn?.addEventListener('click', () => submit('add'));
    removeBtn?.addEventListener('click', () => submit('remove'));
    amountInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit('add');
    });
  }

  window.DashboardCashAdjust = { wire: wireCashAdjust };
})();
