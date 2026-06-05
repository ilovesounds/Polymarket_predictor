/**
 * Day / night theme — apply before paint, persist in localStorage.
 */
(() => {
  const STORAGE_KEY = 'dashboardTheme';
  const THEMES = ['dark', 'light'];

  function normalize(theme) {
    return theme === 'light' ? 'light' : 'dark';
  }

  function getStored() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === 'light' || v === 'dark') return v;
    } catch (_) {}
    return null;
  }

  function getTheme() {
    const stored = getStored();
    if (stored) return stored;
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function applyTheme(theme, { silent = false } = {}) {
    const next = normalize(theme);
    const root = document.documentElement;
    root.setAttribute('data-theme', next);
    root.style.colorScheme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch (_) {}
    if (!silent) {
      window.dispatchEvent(new CustomEvent('dashboard-theme-change', { detail: { theme: next } }));
    }
    return next;
  }

  function toggleTheme() {
    return applyTheme(getTheme() === 'light' ? 'dark' : 'light');
  }

  applyTheme(getStored() || 'dark', { silent: true });

  window.DashboardTheme = {
    STORAGE_KEY,
    THEMES,
    getTheme,
    applyTheme,
    toggleTheme,
  };
})();
