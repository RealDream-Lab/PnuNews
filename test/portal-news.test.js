import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createPortalImporter } from '../src/portal-news.js';

const LINK = 'https://pnu.ac.ir/fa-IR/DouranPortal/6021/news/view/14591/50005750/Staging/x';
const OLD = 'https://pnu.ac.ir/_DouranPortal/Album/News/13b2c628-d574-417e-9885-5ccf0fe4231b_14050824_115351.jpg';
const NEW = 'https://pnu.ac.ir/_DouranPortal/Album/News/84db0197-973c-4202-90a7-f53200a0b2f2_14050824_161857.jpg';

function portalHtml(image) {
  return `<div id="dnn_NewsContentPanel1"><a class="DPNewsItemTitle" href="${LINK}">عنوان خبر</a>
    <img alt="x" src="${image}"><span id="a_DetailsDatePanel" unix="1794730800000"></span>
    <span id="a_NewsAbstract">چکیده</span></div>`;
}

// A pool that knows one imported news (id 155) and records every UPDATE of its cover address.
function fakePool(storedImage) {
  const updates = [];
  const answer = (sql, params) => {
    if (sql.startsWith('SELECT v FROM settings')) return [params[0] === 'portal_news_category_id' ? { v: '5' } : undefined].filter(Boolean);
    if (sql.startsWith('SELECT id FROM categories')) return [{ id: 5 }];
    if (sql.startsWith("SELECT id, is_system FROM users")) return [{ id: 9, is_system: 1 }];
    if (sql.startsWith("SELECT id FROM regions")) return [{ id: 1 }];
    if (sql.startsWith('SELECT id FROM news WHERE source_hash')) return [{ id: 155 }];
    if (sql.startsWith('UPDATE news SET source_image_url')) {
      const [image, id, current] = params;
      if (storedImage === null || storedImage !== current) {
        storedImage = image;
        updates.push({ id, image });
      }
      return [];
    }
    return [];
  };
  return {
    updates,
    stored: () => storedImage,
    execute: async (sql, params) => [answer(sql, params)],
    query: async (sql, params) => [answer(sql, params)],
  };
}

async function runWith(storedImage, portalImage) {
  const pool = fakePool(storedImage);
  const importer = createPortalImporter({
    pool,
    uploadRoot: '/tmp',
    events: new EventEmitter(),
    logger: { info() {}, warn() {}, error() {} },
    fetchHtml: async () => portalHtml(portalImage),
    fetchCover: async () => { throw new Error('not used for a news that already exists'); },
  });
  const result = await importer.runOnce({ force: true });
  return { pool, result };
}

test('a cover the portal replaced after publishing is picked up again (the old file is gone)', async () => {
  const { pool, result } = await runWith(OLD, NEW);
  assert.equal(result.error, null);
  assert.equal(result.created, 0, 'the news itself is not imported twice');
  assert.deepEqual(pool.updates, [{ id: 155, image: NEW }]);
  assert.equal(pool.stored(), NEW);
});

test('an unchanged cover is not rewritten, and a news without a stored address gets one', async () => {
  const same = await runWith(NEW, NEW);
  assert.deepEqual(same.pool.updates, []);
  const missing = await runWith(null, NEW);
  assert.deepEqual(missing.pool.updates, [{ id: 155, image: NEW }]);
});

test('the routes leave the edit decision of portal news to the policy (main admin and central PR)', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const [news, attachments] = [await read('src/routes/news-admin.js'), await read('src/routes/news-attachments.js')];
  assert.match(news, /canEdit: canView && canEditNews\(user, news, \{ regions \}\)/);
  assert.match(attachments, /canEdit: canEditNews\(user, news, \{ regions \}\)/);
  assert.match(attachments, /const canEdit = canEditNews\(request\.user, attachment, \{ regions \}\)/);
  assert.ok(!/!(news|attachment)\.source_url &&/.test(news + attachments), 'no route blocks portal news on its own');
});

// A pool for a news that is not in the database yet: records the SQL of the insert transaction.
function newsPool() {
  const log = [];
  const rows = (sql, params) => {
    if (sql.startsWith('SELECT v FROM settings')) return [params[0] === 'portal_news_category_id' ? { v: '5' } : undefined].filter(Boolean);
    if (sql.startsWith('SELECT id FROM categories')) return [{ id: 5 }];
    if (sql.startsWith('SELECT id, is_system FROM users')) return [{ id: 9, is_system: 1 }];
    if (sql.startsWith('SELECT id FROM regions')) return [{ id: 1 }];
    return [];
  };
  const connection = {
    beginTransaction: async () => {}, commit: async () => { log.push('COMMIT'); }, rollback: async () => { log.push('ROLLBACK'); }, release() {},
    execute: async (sql, params) => {
      log.push(sql.replace(/\s+/g, ' ').trim().slice(0, 40));
      return [sql.startsWith('INSERT INTO news ') ? { insertId: 300 } : sql.startsWith('INSERT INTO attachments') ? { insertId: 41 } : []];
    },
  };
  return { log, execute: async (sql, params) => [rows(sql, params)], query: async (sql, params) => [rows(sql, params)], getConnection: async () => connection };
}

function importWith(pool, fetchCover) {
  const items = [{ title: 'خبر تازه', link: LINK, image: NEW, abstract: 'چکیده', timestamp_ms: 1794730800000 }];
  return createPortalImporter({
    pool,
    uploadRoot: '/tmp',
    events: new EventEmitter(),
    logger: { info() {}, warn() {}, error() {} },
    sourceUrl: 'http://source.invalid/news',
    fetchImpl: async () => new Response(JSON.stringify({ items }), { status: 200 }),
    fetchCover,
  }).runOnce({ force: true });
}

test('a new portal news gets its cover downloaded at import time and saved as its own cover attachment', async () => {
  const pool = newsPool();
  const asked = [];
  const image = { storedName: 'img/2026/11/' + 'b'.repeat(32), mime: 'image/webp', sizeBytes: 500, width: 1280, height: 720, dominantColor: '#112233', variants: [] };
  const result = await importWith(pool, async (url) => { asked.push(url); return image; });
  assert.equal(result.created, 1);
  assert.deepEqual(asked, [NEW]);
  const attachment = pool.log.findIndex((entry) => entry.startsWith('INSERT INTO attachments'));
  assert.ok(attachment > pool.log.findIndex((entry) => entry.startsWith('INSERT INTO news ')), 'after the news row');
  assert.ok(pool.log.some((entry) => entry.startsWith('UPDATE news SET cover_attachment_id')), 'the news points at it');
  assert.equal(pool.log.at(-1), 'COMMIT');
});

test('when the cover cannot be downloaded the news is still imported (with the portal address as before)', async () => {
  const pool = newsPool();
  const result = await importWith(pool, async () => { throw new Error('404'); });
  assert.equal(result.created, 1);
  assert.equal(result.error, null);
  assert.ok(!pool.log.some((entry) => entry.startsWith('INSERT INTO attachments')));
  assert.equal(pool.log.at(-1), 'COMMIT');
});
