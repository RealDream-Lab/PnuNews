import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createPublicRouter } from '../src/routes/public.js';

// The shared module is versioned (live-plan.vX.Y.Z.js), so find it instead of hard-coding the version.
const sharedDir = new URL('../public/shared/', import.meta.url);
const planFile = readdirSync(sharedDir).find((name) => /^live-plan\.v[\d.]+\.js$/.test(name));
const { itemSignature, planLiveUpdate } = await import(new URL(planFile, sharedDir));

const item = (id, minutesAgo, extra = {}) => ({
  id, title: `خبر ${id}`, summary: '', news_type: 'news', is_urgent: false, category: { name: 'آموزشی' },
  cover: { src: `/c/${id}.webp` }, scope: { type: 'country', name: 'کشور' },
  published_at: new Date(Date.UTC(2026, 9, 28, 12, 0) - minutesAgo * 60_000).toISOString(), ...extra,
});
const entry = (value) => ({ id: value.id, item: value, sig: itemSignature(value) });

test('plan: a new top item is inserted before the current first card', () => {
  const entries = [entry(item(2, 5)), entry(item(1, 10))];
  const plan = planLiveUpdate(entries, { items: [item(3, 0), item(2, 5), item(1, 10)], pinned: [], next_cursor: null });
  assert.deepEqual(plan.inserts.map((insert) => [insert.item.id, insert.afterId]), [[3, null]]);
  assert.deepEqual(plan.removed, []);
  assert.equal(plan.resync, false);
});

test('plan: edits, removals and newly pinned items are detected', () => {
  const entries = [entry(item(3, 0)), entry(item(2, 5)), entry(item(1, 10))];
  const plan = planLiveUpdate(entries, {
    items: [item(3, 0, { title: 'عنوان تازه' }), item(1, 10)],
    pinned: [item(1, 10, { is_pinned: true })],
    next_cursor: null,
  });
  assert.deepEqual(plan.updates.map((value) => value.id), [3]);
  assert.deepEqual(plan.removed.sort(), [1, 2]);
});

test('plan: items older than a partial window are never treated as removed', () => {
  const entries = [entry(item(3, 0)), entry(item(2, 5)), entry(item(1, 600))];
  const plan = planLiveUpdate(entries, { items: [item(3, 0), item(2, 5)], pinned: [], next_cursor: 'x' });
  assert.deepEqual(plan.removed, []);
});

test('plan: a burst of new items or a total mismatch asks for a full reload', () => {
  const entries = [entry(item(100, 500))];
  const burst = Array.from({ length: 8 }, (_, index) => item(index + 1, index));
  assert.equal(planLiveUpdate(entries, { items: burst, pinned: [], next_cursor: 'x' }).resync, true);
});

test('live endpoint streams a feed event after news changes and drops closed clients', async () => {
  const events = new EventEmitter();
  const app = express();
  app.use(createPublicRouter({ pool: {}, config: { publicUrl: 'http://localhost' }, events }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const received = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no live event received')), 4000);
      const request = http.get({ port, host: '127.0.0.1', path: '/api/public/live' }, (response) => {
        assert.equal(response.statusCode, 200);
        assert.match(response.headers['content-type'], /text\/event-stream/);
        assert.equal(response.headers['x-accel-buffering'], 'no');
        let buffer = '';
        let finished = false;
        // Closing a stream on purpose makes some Node versions emit ECONNRESET / "aborted" on the response too.
        response.on('error', () => {});
        response.on('aborted', () => {});
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          buffer += chunk;
          if (!finished && buffer.includes('event: feed')) {
            finished = true;
            clearTimeout(timeout);
            resolve(buffer);
            response.destroy();
          }
        });
        setTimeout(() => events.emit('news.published', { id: 7 }), 50);
      });
      request.on('error', () => {});
    });
    assert.match(received, /retry: 5000/);
    assert.match(received, /event: feed\nid: \d+\ndata: \d+/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
