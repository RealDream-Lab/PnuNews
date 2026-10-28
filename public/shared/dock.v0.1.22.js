// Footer shared by the reader and the admin panel: app name + running version + the internet radio player.
// The version comes from this file's own versioned name (dock.v0.1.22.js), so it always matches the code that is running.
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
      navigator.mediaSession.setActionHandler('pause', stop);
    } catch {}
  }

  // It is a live stream: a plain pause would freeze the player at that moment, keep downloading in the background,
  // and later resume with old audio. So "pause" ends the connection, and "play" reconnects at the live moment.
  // The play/stop icon is set here directly. It must not depend on the audio element's own 'pause' event:
  // stop() calls load() right after pause(), and load() discards the still-queued 'pause' event, so the icon stayed on "stop".
  function setPlayingUi(playing) {
    const button = radioRoot?.querySelector('.radio-play');
    if (!button) return;
    button.innerHTML = `<svg class="icon"><use href="#icon-${playing ? 'stop' : 'play'}"/></svg>`;
    button.setAttribute('aria-label', playing ? 'توقف رادیو' : 'پخش رادیو');
  }

  function stop() {
    if (!audio) return;
    audio.pause();
    if (audio.getAttribute('src')) {
      audio.removeAttribute('src');
      audio.load();
    }
    setPlayingUi(false);
  }

  async function play() {
    if (!audio || !streamUrl) return;
    if (!audio.getAttribute('src')) audio.src = streamUrl;
    try { await audio.play(); } catch {
      stop();
      showToast('پخش رادیو آغاز نشد؛ اتصال را بررسی کنید.');
    }
  }

  // A long title scrolls back and forth (right, pause, left, pause) instead of being cut off with an ellipsis.
  function fitNowPlaying() {
    const caption = radioRoot?.querySelector('.radio-now-playing');
    const text = caption?.querySelector('.np-text');
    if (!caption || !text) return;
    caption.classList.remove('is-scrolling');
    const overflow = Math.ceil(text.scrollWidth - caption.clientWidth);
    if (overflow <= 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const direction = getComputedStyle(caption).direction === 'rtl' ? 1 : -1;
    caption.style.setProperty('--np-shift', `${overflow * direction}px`);
    caption.style.setProperty('--np-duration', `${Math.max(8, 4 + overflow / 12)}s`);
    caption.classList.add('is-scrolling');
  }

  function setNowPlayingText(value) {
    const text = radioRoot?.querySelector('.radio-now-playing .np-text');
    if (!text || text.textContent === value) return;
    text.textContent = value;
    requestAnimationFrame(fitNowPlaying);
  }
  window.addEventListener('resize', () => requestAnimationFrame(fitNowPlaying), { passive: true });

  async function refreshNowPlaying() {
    try {
      const response = await fetch('/api/public/radio', { headers: { accept: 'application/json' } });
      if (!response.ok) return;
      const data = await response.json();
      const song = data.now_playing;
      setNowPlayingText(song?.title ? `${song.title}${song.artist ? ` — ${song.artist}` : ''}` : 'پخش زندهٔ رادیو');
      if (song?.title) setMediaMetadata(song.title, song.artist || stationTitle);
    } catch {}
  }

  function renderRadio(radio) {
    if (!radioRoot) return;
    const enabled = radio?.enabled && radio.stream_url;
    if (!enabled) {
      if (audio) stop();
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
    if (streamUrl !== radio.stream_url && audio) stop();
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
      audio.addEventListener('play', () => setPlayingUi(true));
      audio.addEventListener('pause', () => {
        // Paused by something else (headphone button, another app taking audio focus): still drop the stream.
        if (audio.getAttribute('src')) stop();
        else setPlayingUi(false);
      });
      audio.addEventListener('error', () => {
        if (!audio.getAttribute('src')) return; // not for the stream we closed on purpose
        stop(); // a failed stream never pauses by itself; reset the button instead of leaving it on "stop"
        showToast('پخش رادیو در دسترس نیست.');
      });
    }
    if (!radioRoot.querySelector('.radio-bar')) {
      radioRoot.innerHTML = `<section class="radio-bar" aria-label="پخش رادیوی دانشگاه">
      <button class="audio-button radio-play" type="button" aria-label="پخش رادیو"><svg class="icon"><use href="#icon-play"/></svg></button>
      <div class="radio-info"><strong class="radio-title"></strong><span class="radio-now-playing"><span class="np-text">پخش زندهٔ رادیو</span></span></div>
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
      stop();
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

  return { renderRadio, loadRadio, setMediaMetadata };
}
