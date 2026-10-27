(() => {
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const stored = () => {
    try {
      const value = localStorage.getItem('pnu.theme');
      return value === 'light' || value === 'dark' ? value : null;
    } catch {
      return null;
    }
  };
  root.dataset.theme = stored() ?? (media.matches ? 'dark' : 'light');
  // Until the visitor picks a theme explicitly, keep following the system setting.
  media.addEventListener?.('change', (event) => {
    if (!stored()) root.dataset.theme = event.matches ? 'dark' : 'light';
  });
})();
