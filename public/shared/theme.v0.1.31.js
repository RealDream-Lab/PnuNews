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
  // Browser chrome (address bar, title bar, status bar) and the installed-app manifest follow the page theme,
  // so header, frame and page are one colour. The manifest is only read at install time; the meta tag also works live.
  const chrome = () => {
    const dark = root.dataset.theme === 'dark';
    const color = dark ? '#0b1220' : '#f4f7fb';
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.append(meta); }
    meta.setAttribute('content', color);
    const link = document.getElementById('app-manifest');
    if (link) {
      const touch = matchMedia('(pointer: coarse) and (hover: none)').matches;
      const href = `/manifest${touch ? '-mobile' : ''}${dark ? '-dark' : ''}.webmanifest`;
      if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    }
  };
  root.dataset.theme = stored() ?? (media.matches ? 'dark' : 'light');
  chrome();
  // Until the visitor picks a theme explicitly, keep following the system setting.
  media.addEventListener?.('change', (event) => {
    if (!stored()) root.dataset.theme = event.matches ? 'dark' : 'light';
  });
  // Any change of the theme (toggle buttons, system) refreshes the browser chrome too.
  new MutationObserver(chrome).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
})();
