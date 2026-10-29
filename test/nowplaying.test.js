import assert from 'node:assert/strict';
import test from 'node:test';
import { describeNowPlayingError, fetchNowPlaying, makeRadioResolver, parseNowPlaying, resolveNowPlayingUrl } from '../src/lib/nowplaying.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const allowAll = async () => true;

test('AzuraCast single-station answer', () => {
  assert.deepEqual(parseNowPlaying({ now_playing: { song: { title: 'آهنگ', artist: 'خواننده' } } }), { title: 'آهنگ', artist: 'خواننده' });
  assert.deepEqual(parseNowPlaying({ now_playing: { song: { text: 'Artist - Title' } } }), { title: 'Title', artist: 'Artist' });
});

test('AzuraCast all-stations array picks the station of the stream, else the first', () => {
  const data = [
    { station: { listen_url: 'https://r.example/a' }, now_playing: { song: { title: 'A', artist: '' } } },
    { station: { listen_url: 'https://r.example/b', mounts: [{ url: 'https://r.example/b2' }] }, now_playing: { song: { title: 'B', artist: 'x' } } },
  ];
  assert.equal(parseNowPlaying(data, { streamUrl: 'https://r.example/b2' }).title, 'B');
  assert.equal(parseNowPlaying(data, { streamUrl: 'https://other/' }).title, 'A');
  assert.equal(parseNowPlaying([]), null);
});

test('Icecast and Shoutcast answers', () => {
  assert.deepEqual(parseNowPlaying({ icestats: { source: [{ title: 'T', artist: 'A' }] } }), { title: 'T', artist: 'A' });
  assert.deepEqual(parseNowPlaying({ icestats: { source: { yp_currently_playing: 'A - T' } } }), { title: 'T', artist: 'A' });
  assert.deepEqual(parseNowPlaying({ songtitle: 'A - T' }), { title: 'T', artist: 'A' });
  assert.equal(parseNowPlaying({ nothing: true }), null);
  assert.equal(parseNowPlaying('x'), null);
});

test('redirects are followed and every hop is checked', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (url.protocol === 'http:') return new Response(null, { status: 301, headers: { location: 'https://radio.example/api/nowplaying/1' } });
    return json({ now_playing: { song: { title: 'T', artist: 'A' } } });
  };
  const result = await fetchNowPlaying('http://radio.example/api/nowplaying/1', { fetchImpl, resolvesPublic: allowAll });
  assert.deepEqual(result, { title: 'T', artist: 'A' });
  assert.equal(seen.length, 2);

  const toInternal = async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/secret' } });
  await assert.rejects(fetchNowPlaying('https://radio.example/x', { fetchImpl: toInternal, resolvesPublic: async (host) => host !== '10.0.0.5' }), { code: 'internal' });
  const loop = async (url) => new Response(null, { status: 302, headers: { location: String(url) } });
  await assert.rejects(fetchNowPlaying('https://radio.example/x', { fetchImpl: loop, resolvesPublic: allowAll }), { code: 'redirects' });
});

test('failures carry a readable reason', async () => {
  await assert.rejects(fetchNowPlaying('https://radio.example/x', { fetchImpl: async () => json({}, 503), resolvesPublic: allowAll }), { code: 'status', detail: '503' });
  await assert.rejects(fetchNowPlaying('https://radio.example/x', { fetchImpl: async () => new Response('<html>', { status: 200 }), resolvesPublic: allowAll }), { code: 'json' });
  await assert.rejects(fetchNowPlaying('http://radio.example/x', { publicUrl: 'https://news.example', fetchImpl: async () => json({}), resolvesPublic: allowAll }), { code: 'https' });
});

test('network failures name the cause, and the administrator gets a readable message', async () => {
  const failing = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(fetchNowPlaying('https://radio.example/x', { fetchImpl: failing, resolvesPublic: allowAll }), { code: 'network', detail: 'ECONNREFUSED' });
  assert.match(describeNowPlayingError({ code: 'network', detail: 'ECONNREFUSED' }), /ECONNREFUSED/);
  assert.match(describeNowPlayingError({ code: 'internal', detail: 'radiostream.pnu.ac.ir' }), /RADIO_TRUSTED_HOSTS/);
});

test('operator-trusted hosts skip the public-address check, others do not', async () => {
  const resolver = makeRadioResolver(['radiostream.pnu.ac.ir'], async () => false);
  assert.equal(await resolver('radiostream.pnu.ac.ir'), true);
  assert.equal(await resolver('RADIOSTREAM.pnu.ac.ir'), true);
  assert.equal(await resolver('other.example'), false);
});

test('an empty now-playing address falls back to the stream server\'s AzuraCast API', () => {
  assert.equal(resolveNowPlayingUrl({ nowPlayingUrl: 'https://a.example/api/nowplaying/1' }).href, 'https://a.example/api/nowplaying/1');
  assert.equal(resolveNowPlayingUrl({ streamUrl: 'https://radiostream.pnu.ac.ir/listen/pnu/radio.mp3' }).href, 'https://radiostream.pnu.ac.ir/api/nowplaying');
  assert.equal(resolveNowPlayingUrl({}), null);
});
