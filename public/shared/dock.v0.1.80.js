// Footer shared by the reader and the admin panel: it carries only the internet radio player
// (the version number lives in the About dialog).

export function initDock({ showToast = () => {} } = {}) {
  const radioRoot = document.getElementById('radio-root');

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
    button.classList.toggle('is-playing', playing);
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

  // ---------- Autoplay (reader home page) ----------
  // Starts the radio as soon as the page is up. Browsers refuse sound before the visitor has touched the page
  // (NotAllowedError); then the attempt is repeated on the visitor's first real interaction instead of showing an error.
  // Anything that is not "blocked by policy" (a dead stream, no network) ends the attempt quietly.
  let autoplayDone = false;
  let cancelAutoplayWait = null;

  function cancelAutoplay() {
    autoplayDone = true;
    cancelAutoplayWait?.();
    cancelAutoplayWait = null;
  }

  // true: playing; 'blocked': the browser wants a user gesture first; false: failed for another reason.
  async function tryAutoplay() {
    if (!audio || !streamUrl) return false;
    if (!audio.getAttribute('src')) audio.src = streamUrl;
    try {
      await audio.play();
      return true;
    } catch (error) {
      stop();
      return error?.name === 'NotAllowedError' ? 'blocked' : false;
    }
  }

  async function autoplayRadio() {
    if (autoplayDone || !audio || !streamUrl) return;
    autoplayDone = true;
    const first = await tryAutoplay();
    if (first !== 'blocked') return;
    const events = ['pointerup', 'touchend', 'keydown', 'click'];
    let busy = false;
    const finish = () => {
      for (const name of events) document.removeEventListener(name, onGesture, true);
      cancelAutoplayWait = null;
    };
    async function onGesture(event) {
      // The visitor is using the radio button themselves: respect that and do not start anything on top of it.
      if (radioRoot?.contains(event.target)) { finish(); return; }
      if (busy) return;
      busy = true;
      const result = await tryAutoplay();
      busy = false;
      // A scroll or a key the browser does not count as a gesture is refused again: keep waiting for the next one.
      if (result !== 'blocked') finish();
    }
    for (const name of events) document.addEventListener(name, onGesture, true);
    cancelAutoplayWait = finish;
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

  // "Now playing" normally comes from this site's server (/api/public/radio). When that server cannot reach the
  // radio (it answers reachable:false), the browser asks the radio's own API directly instead.
  let nowPlayingUrl = '';
  let directMode = false;

  function songFrom(song) {
    if (!song || typeof song !== 'object') return null;
    let title = String(song.title ?? song.name ?? '').trim();
    let artist = String(song.artist ?? song.artist_name ?? '').trim();
    if (!title && !artist && song.text) {
      const text = String(song.text).trim();
      const index = text.indexOf(' - ');
      if (index > 0) { artist = text.slice(0, index).trim(); title = text.slice(index + 3).trim(); } else title = text;
    }
    return title || artist ? { title, artist } : null;
  }

  // AzuraCast (one station, or the array of all stations), Icecast and Shoutcast answers.
  function parseNowPlaying(data) {
    if (Array.isArray(data)) {
      const stations = data.filter((item) => item && typeof item === 'object');
      const match = stations.find((item) => item.station?.listen_url === streamUrl || item.station?.mounts?.some?.((mount) => mount?.url === streamUrl));
      return parseNowPlaying(match || stations[0] || null);
    }
    if (!data || typeof data !== 'object') return null;
    const direct = songFrom(data.now_playing?.song) ?? songFrom(data.song);
    if (direct) return direct;
    const source = data.icestats?.source;
    for (const item of Array.isArray(source) ? source : source ? [source] : []) {
      const found = songFrom({ title: item.title, artist: item.artist }) ?? (item.yp_currently_playing ? songFrom({ text: item.yp_currently_playing }) : null);
      if (found) return found;
    }
    return typeof data.songtitle === 'string' ? songFrom({ text: data.songtitle }) : null;
  }

  async function fetchDirect() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(nowPlayingUrl, { cache: 'no-store', credentials: 'omit', signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('bad status');
      return parseNowPlaying(await response.json());
    } finally { clearTimeout(timer); }
  }

  async function refreshNowPlaying() {
    let song = null;
    try {
      if (!directMode) {
        const response = await fetch('/api/public/radio', { cache: 'no-store', headers: { accept: 'application/json' } });
        if (!response.ok) return;
        const data = await response.json();
        if (data.reachable === false && nowPlayingUrl) directMode = true;
        else song = data.now_playing;
      }
      if (directMode) {
        try { song = await fetchDirect(); } catch { directMode = false; } // blocked or unreachable: ask the server again next time
      }
    } catch { return; }
    setNowPlayingText(song?.title ? `${song.title}${song.artist ? ` — ${song.artist}` : ''}` : 'پخش زندهٔ رادیو');
    if (song?.title) setMediaMetadata(song.title, song.artist || stationTitle);
  }

  function renderRadio(radio) {
    if (!radioRoot) return;
    const enabled = radio?.enabled && radio.stream_url;
    // The footer only exists for the radio: hide it with the attribute, not with :has() (older browsers ignore that).
    const dockElement = radioRoot.closest('.site-dock');
    if (dockElement) dockElement.hidden = !enabled;
    if (!enabled) {
      cancelAutoplayWait?.();
      cancelAutoplayWait = null;
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
      nowPlayingUrl = '';
      directMode = false;
      stationTitle = '';
      clearInterval(nowPlayingTimer);
      return;
    }
    if (streamUrl !== radio.stream_url && audio) stop();
    streamUrl = radio.stream_url;
    nowPlayingUrl = radio.nowplaying_url || '';
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
      audio.addEventListener('play', () => { setPlayingUi(true); refreshNowPlaying(); });
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
    cancelAutoplay();
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

  function stopRadio() {
    cancelAutoplay();
    stop();
  }

  return { renderRadio, loadRadio, setMediaMetadata, stopRadio, autoplayRadio };
}
