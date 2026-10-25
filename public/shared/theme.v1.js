(() => {
  let theme = 'auto';
  try {
    const saved = localStorage.getItem('pnu.theme');
    if (saved === 'light' || saved === 'dark' || saved === 'auto') theme = saved;
  } catch {}
  document.documentElement.dataset.theme = theme;
})();
