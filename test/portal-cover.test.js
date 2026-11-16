import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { CoverDownloadError, attachCover, coverOriginalName, downloadPortalImage, localizeCover, removeCoverFiles } from '../src/lib/portal-cover.js';

const URL_OK = 'https://pnu.ac.ir/_DouranPortal/Album/News/abc_14050824_115351.jpg';
const JPEG = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#3366cc' } }).jpeg().toFile(path.join(os.tmpdir(), 'pnu-cover-fixture.jpg')).then(() => readFile(path.join(os.tmpdir(), 'pnu-cover-fixture.jpg')));
const respond = (status, body = '', headers = {}) => new Response(body, { status, headers });

test('only https addresses on pnu.ac.ir are downloaded, and a redirect may not leave them', async () => {
  let calls = 0;
  const never = async () => { calls += 1; return respond(200, JPEG); };
  for (const address of ['http://pnu.ac.ir/a.jpg', 'https://evil.example/a.jpg', 'https://pnu.ac.ir.evil.example/a.jpg', 'file:///etc/passwd', null]) {
    await assert.rejects(downloadPortalImage(address, { fetchImpl: never }), CoverDownloadError, String(address));
  }
  assert.equal(calls, 0, 'nothing was requested');
  const offSite = async () => respond(302, '', { location: 'https://evil.example/x.jpg' });
  await assert.rejects(downloadPortalImage(URL_OK, { fetchImpl: offSite }), /نامعتبری/);
  const hops = [];
  const sameSite = async (target) => { hops.push(target); return hops.length === 1 ? respond(301, '', { location: '/_DouranPortal/Album/News/new.jpg' }) : respond(200, JPEG); };
  assert.ok((await downloadPortalImage(URL_OK, { fetchImpl: sameSite })).length > 100);
  assert.equal(hops[1], 'https://pnu.ac.ir/_DouranPortal/Album/News/new.jpg');
});

test('a missing picture is reported as gone, a flaky connection is retried, a huge or fake picture is refused', async () => {
  await assert.rejects(downloadPortalImage(URL_OK, { fetchImpl: async () => respond(404) }), (error) => error.gone === true && error.status === 404);
  await assert.rejects(downloadPortalImage(URL_OK, { fetchImpl: async () => respond(500) }), (error) => error.gone === false);
  let attempts = 0;
  const flaky = async () => { attempts += 1; if (attempts < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }); return respond(200, JPEG); };
  assert.ok((await downloadPortalImage(URL_OK, { fetchImpl: flaky, retryDelayMs: 1 })).length > 100);
  assert.equal(attempts, 3);
  await assert.rejects(downloadPortalImage(URL_OK, { fetchImpl: async () => respond(200, JPEG), maxBytes: 100 }), /حجم/);
  await assert.rejects(localizeCover({ url: URL_OK, uploadRoot: os.tmpdir(), fetchImpl: async () => respond(200, '<html>not a picture</html>') }), /تصویر معتبر نیست/);
});

test('a downloaded cover becomes the same WebP set as an uploaded one, and the temporary file is removed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pnu-cover-'));
  try {
    const seen = [];
    const image = await localizeCover({ url: URL_OK, uploadRoot: root, fetchImpl: async () => respond(200, JPEG), processImage: async (input, uploadRoot, options) => {
      seen.push({ input, options, exists: existsSync(input) });
      const { processImage } = await import('../src/lib/images.js');
      return processImage(input, uploadRoot, options);
    } });
    assert.equal(seen[0].options.kind, 'cover');
    assert.ok(seen[0].exists);
    assert.ok(!existsSync(seen[0].input), 'temporary download is deleted');
    assert.match(image.storedName, /^img\/\d{4}\/(0[1-9]|1[0-2])\/[a-f\d]{32}$/);
    assert.deepEqual(image.variants.map((variant) => variant.width), [64, 64, 64], 'never enlarged beyond the original');
    assert.ok(image.variants.every((variant) => existsSync(variant.path)));
    await removeCoverFiles(image);
    assert.ok(image.variants.every((variant) => !existsSync(variant.path)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the cover attachment is inserted and set on the news without touching its modification time', async () => {
  const log = [];
  const connection = { execute: async (sql, params) => { log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return [{ insertId: 41 }]; } };
  const id = await attachCover(connection, 7, { storedName: 'img/2026/11/' + 'a'.repeat(32), mime: 'image/webp', sizeBytes: 900, width: 1280, height: 720, dominantColor: '#3366cc' }, URL_OK);
  assert.equal(id, 41);
  assert.match(log[0].sql, /^INSERT INTO attachments .* VALUES \(\?, 'cover'/);
  assert.deepEqual(log[0].params, [7, 'abc_14050824_115351.jpg', 'img/2026/11/' + 'a'.repeat(32), 'image/webp', 900, 1280, 720, '#3366cc']);
  assert.equal(log[1].sql, 'UPDATE news SET cover_attachment_id = ?, updated_at = updated_at WHERE id = ?');
  assert.deepEqual(log[1].params, [41, 7]);
  assert.equal(coverOriginalName('https://pnu.ac.ir/x/%D8%B9%DA%A9%D8%B3.jpg'), 'عکس.jpg');
});
