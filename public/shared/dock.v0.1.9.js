// Footer shared by the reader and the admin panel: app name + running version + the internet radio player.
// The version comes from this file's own versioned name (dock.v0.1.9.js), so it always matches the code that is running.
const persianDigits = '۰۱۲۳۴۵۶۷۸۹';

export function initDock({ showToast = () => {} } = {}) {
  const radioRoot = document.getElementById('radio-root');
  const dockText = document.querySelector('.dock-text');
  const version = /dock\.v([\d.]+)\.js/.exec(import.meta.url)?.[1];
  if (version && dockText && !dockText.querySelector('.dock-version')) {
    const label = document.createElement('span');
    label.className = 'dock-version';
    label.textContent = ` · نسخه ${version.replace(/\d/g, (digit) => persianDigits[digit])}`;
    dockText.append(label);
  }

  let audio = null;
  let streamUrl = '';
  let stationTitle = '';
  let nowPlayingTimer = null;

  function setMediaMetadata(title, artist) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album: stationTitle || 'رادیو' });
      navigator.mediaSession.setActionHandler('play', play);
      navigator.mediaSession.setActionHandler('pause', () => audio?.pause());
    } catch {}
  }

  async function play() {
    if (!audio || !streamUrl) return;
    if (!audio.src) audio.src = streamUrl;
    try { await audio.play(); } catch { showToast('پخش رادیو آغاز نشد؛ اتصال را بررسی کنید.'); }
  }

  async function refreshNowPlaying() {
    try {
      const response = await fetch('/api/public/radio', { headers: { accept: 'application/json' } });
      if (!response.ok) return;
      const data = await response.json();
      const caption = radioRoot?.querySelector('.radio-now-playing');
      if (!caption) return;
      const song = data.now_playing;
      caption.textContent = song?.title ? `${song.title}${song.artist ? ` — ${song.artist}` : ''}` : 'پخش زندهٔ رادیو';
      if (song?.title) setMediaMetadata(song.title, song.artist || stationTitle);
    } catch {}
  }

  function renderRadio(radio) {
    if (!radioRoot) return;
    const enabled = radio?.enabled && radio.stream_url;
    if (!enabled) {
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      radioRoot.replaceChildren();
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.setActionHandler('play', null);
          navigator.mediaSession.setActionHandler('pause', null);
          navigator.mediaSession.metadata = null;
        } catch {}
      }
      streamUrl = '';
      stationTitle = '';
      clearInterval(nowPlayingTimer);
      return;
    }
    if (streamUrl !== radio.stream_url && audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    streamUrl = radio.stream_url;
    stationTitle = radio.title || 'رادیو';
    if (!audio) {
      audio = document.createElement('audio');
      audio.preload = 'none';
      audio.volume = .6;
      try {
        const saved = localStorage.getItem('pnu.radioVolume');
        const volume = saved === null || saved === '' ? NaN : Number(saved);
        if (volume >= 0 && volume <= 1) audio.volume = volume;
      } catch {}
      audio.addEventListener('play', () => {
        const button = radioRoot.querySelector('.radio-play');
        if (button) {
          button.innerHTML = '<svg class="icon"><use href="#icon-pause"/></svg>';
          button.setAttribute('aria-label', 'توقف رادیو');
        }
      });
      audio.addEventListener('pause', () => {
        const button = radioRoot.querySelector('.radio-play');
        if (button) {
          button.innerHTML = '<svg class="icon"><use href="#icon-play"/></svg>';
          button.setAttribute('aria-label', 'پخش رادیو');
        }
      });
      audio.addEventListener('error', () => showToast('پخش رادیو در دسترس نیست.'));
    }
    if (!radioRoot.querySelector('.radio-bar')) {
      radioRoot.innerHTML = `<section class="radio-bar" aria-label="پخش رادیوی دانشگاه">
      <button class="audio-button radio-play" type="button" aria-label="پخش رادیو"><svg class="icon"><use href="#icon-play"/></svg></button>
      <div class="radio-info"><strong class="radio-title"></strong><span class="radio-now-playing">پخش زندهٔ رادیو</span></div>
      <label class="volume-control" aria-label="بلندی صدا"><svg class="icon"><use href="#icon-volume"/></svg><input class="radio-volume" type="range" min="0" max="1" step="0.05" aria-label="بلندی صدا"></label>
    </section>`;
      radioRoot.querySelector('.radio-volume').value = String(audio.volume);
    }
    radioRoot.querySelector('.radio-title').textContent = stationTitle;
    setMediaMetadata(stationTitle, 'رادیوی اینترنتی');
    clearInterval(nowPlayingTimer);
    refreshNowPlaying();
    nowPlayingTimer = setInterval(refreshNowPlaying, 20_000);
  }

  radioRoot?.addEventListener('click', async (event) => {
    const button = event.target.closest('.radio-play');
    if (!button || !streamUrl || !audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    await play();
  });
  radioRoot?.addEventListener('input', (event) => {
    if (!event.target.matches('.radio-volume') || !audio) return;
    audio.volume = Number(event.target.value);
    try { localStorage.setItem('pnu.radioVolume', String(audio.volume)); } catch {}
  });

  // For pages that do not already have the public config at hand (the admin panel).
  async function loadRadio() {
    try {
      const response = await fetch('/api/public/config', { headers: { accept: 'application/json' } });
      if (response.ok) renderRadio((await response.json()).radio);
    } catch {}
  }

  return { renderRadio, loadRadio };
}
