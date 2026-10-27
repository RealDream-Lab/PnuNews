// Touch-only devices (phones, tablets) get the full-screen manifest; desktops keep the normal app window.
(() => {
  const link = document.getElementById('app-manifest');
  if (link && matchMedia('(pointer: coarse) and (hover: none)').matches) link.href = '/manifest-mobile.webmanifest';
})();
