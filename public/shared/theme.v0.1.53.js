(() => {
  const root = document.documentElement;
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
      const base = link.dataset.manifestBase || '/manifest';
      const href = `${base}${touch ? '-mobile' : ''}${dark ? '-dark' : ''}.webmanifest`;
      if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    }
  };
  // Night mode is the default; only an explicit choice of the visitor (stored) switches it to light.
  root.dataset.theme = stored() ?? 'dark';
  chrome();
  // Any change of the theme (toggle buttons, system) refreshes the browser chrome too.
  new MutationObserver(chrome).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
})();
