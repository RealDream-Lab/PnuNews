import { readLimitedText, resolvesToPublicAddress } from './net-guard.js';

const MAX_REDIRECTS = 3;

export class NowPlayingError extends Error {
  constructor(code, detail = '') {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.detail = detail;
  }
}

// What the administrator sees when the now-playing address does not work.
export function describeNowPlayingError(error) {
  const detail = error?.detail ? ` (${error.detail})` : '';
  switch (error?.code) {
    case 'internal': return `نام دامنه یا نشانی${detail} به شبکهٔ داخلی یا نشانی غیرعمومی می‌رسد (یا اصلاً resolve نمی‌شود) و سرور برای امنیت آن را نمی‌خواند. اگر مطمئن هستید، نام میزبان را در RADIO_TRUSTED_HOSTS فایل .autostart بگذارید و برنامه را restart کنید.`;
    case 'network': return `سرور برنامه به نشانی اکنون‌پخش وصل نشد${detail}. اتصال شبکه، فایروال و گواهی TLS سرور رادیو را از داخل سرور برنامه بررسی کنید.`;
    case 'status': return `سرور رادیو پاسخ خطا داد${detail}.`;
    case 'json': return 'پاسخ سرور رادیو JSON معتبر نیست؛ نشانی باید به API اکنون‌پخش (مثلاً /api/nowplaying/1) اشاره کند.';
    case 'https': return 'در سایت امن HTTPS نشانی HTTP پذیرفته نمی‌شود.';
    case 'redirects': return 'نشانی بیش از حد ریدایرکت می‌شود.';
    case 'unsupported': return 'فقط نشانی HTTP یا HTTPS بدون نام کاربری و گذرواژه پذیرفته می‌شود.';
    default: return 'خواندن اکنون‌پخش ناموفق بود.';
  }
}

// Empty field: try the usual AzuraCast address of the stream's own server.
export function resolveNowPlayingUrl({ nowPlayingUrl = '', streamUrl = '' } = {}) {
  if (nowPlayingUrl) return new URL(nowPlayingUrl);
  if (!streamUrl) return null;
  try { return new URL('/api/nowplaying', streamUrl); } catch { return null; }
}

function clean(value, maxLength = 200) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength) : '';
}

// "Artist - Title" (what Icecast/Shoutcast send as one string) -> { artist, title }
function splitCombined(text) {
  const value = clean(text);
  const index = value.indexOf(' - ');
  if (index > 0) return { artist: value.slice(0, index).trim(), title: value.slice(index + 3).trim() };
  return { artist: '', title: value };
}

function fromSong(song) {
  if (!song || typeof song !== 'object') return null;
  let title = clean(song.title ?? song.name);
  let artist = clean(song.artist ?? song.artist_name);
  if (!title && !artist && song.text) ({ title, artist } = splitCombined(song.text));
  return title || artist ? { title, artist } : null;
}

// Understands the usual "now playing" JSON shapes:
//  - AzuraCast: { now_playing: { song: {...} } } for one station, or an array with one entry per station
//  - AzuraCast static file / generic: { song: {...} }
//  - Icecast status-json.xsl: { icestats: { source: {title, artist} | [..] } }
//  - Shoutcast v2: { songtitle: "Artist - Title" }
export function parseNowPlaying(data, { streamUrl = '' } = {}) {
  if (Array.isArray(data)) {
    const stations = data.filter((item) => item && typeof item === 'object');
    const wanted = String(streamUrl || '');
    const match = wanted && stations.find((item) => {
      const station = item.station ?? {};
      return station.listen_url === wanted || (Array.isArray(station.mounts) && station.mounts.some((mount) => mount?.url === wanted));
    });
    return parseNowPlaying(match || stations[0] || null);
  }
  if (!data || typeof data !== 'object') return null;
  const direct = fromSong(data.now_playing?.song) ?? fromSong(data.song);
  if (direct) return direct;
  const source = data.icestats?.source;
  const sources = Array.isArray(source) ? source : source ? [source] : [];
  for (const item of sources) {
    const found = fromSong({ title: item.title, artist: item.artist }) ?? (item.yp_currently_playing ? fromSong({ text: item.yp_currently_playing }) : null);
    if (found) return found;
  }
  if (typeof data.songtitle === 'string') return fromSong({ text: data.songtitle });
  return null;
}

// Fetches the administrator-supplied URL. Redirects (http -> https, a trailing slash, ...) are followed by hand,
// and every hop is checked again, so the server still cannot be pointed at the internal network.
export async function fetchNowPlaying(startUrl, {
  fetchImpl = fetch, publicUrl = '', streamUrl = '', resolvesPublic = resolvesToPublicAddress, timeoutMs = 5000,
} = {}) {
  let url = new URL(startUrl);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new NowPlayingError('unsupported');
    if (publicUrl.startsWith('https://') && url.protocol === 'http:') throw new NowPlayingError('https');
    if (!await resolvesPublic(url.hostname)) throw new NowPlayingError('internal', url.hostname);
    let upstream;
    try {
      upstream = await fetchImpl(url, { signal, redirect: 'manual', headers: { accept: 'application/json' } });
    } catch (error) {
      throw new NowPlayingError('network', error.cause?.code || error.name || error.message);
    }
    const location = upstream.headers?.get?.('location');
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    if (!upstream.ok) throw new NowPlayingError('status', String(upstream.status));
    let data;
    try { data = JSON.parse(await readLimitedText(upstream, 256 * 1024)); } catch { throw new NowPlayingError('json'); }
    return parseNowPlaying(data, { streamUrl });
  }
  throw new NowPlayingError('redirects');
}

// Public-address check that lets the operator whitelist host names (config.radioTrustedHosts).
export function makeRadioResolver(trustedHosts = [], base = resolvesToPublicAddress) {
  const trusted = new Set(trustedHosts);
  return async (hostname) => trusted.has(String(hostname).toLowerCase()) || base(hostname);
}
