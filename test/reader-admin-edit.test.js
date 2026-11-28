import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createReaderAdminRouter } from '../src/routes/readers-admin.js';

const READER = { id: 7, phone: '+989121234567', first_name: 'علی', last_name: 'رضایی', is_student: 1, student_no: '40012345', unit_id: 5 };

// A pool that answers the few statements the edit and delete routes run, and records every write.
function fakePool({ reader = READER, visibleUnits = [5, 6], duplicateStudentNo = false } = {}) {
  const writes = [];
  return {
    writes,
    execute: async (sql, params) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT id, phone, first_name/.test(text)) return [reader && Number(params[0]) === reader.id ? [reader] : [], []];
      if (/^SELECT id FROM regions WHERE id = \? AND type = 'city'/.test(text)) return [visibleUnits.includes(Number(params[0])) ? [{ id: params[0] }] : [], []];
      if (/^UPDATE reader_users SET/.test(text)) {
        if (duplicateStudentNo) throw Object.assign(new Error('Duplicate entry for key student_no'), { code: 'ER_DUP_ENTRY' });
        writes.push({ sql: text, params });
        return [{ affectedRows: 1 }, []];
      }
      if (/^DELETE FROM reader_users WHERE id = \? AND staff_user_id IS NULL$/.test(text)) {
        writes.push({ sql: text, params });
        return [{ affectedRows: reader && Number(params[0]) === reader.id ? 1 : 0 }, []];
      }
      if (/^INSERT INTO audit_log/.test(text)) { writes.push({ sql: text, params }); return [{}, []]; }
      throw new Error(`unhandled: ${text}`);
    },
    query: async () => [[], []],
  };
}

async function call(pool, role, method, path, body) {
  const app = express();
  app.use(express.json());
  app.use((request, response, next) => { request.user = role ? { id: 1, role } : undefined; next(); });
  app.use('/api/admin/readers', createReaderAdminRouter({ pool, events: new EventEmitter() }));
  app.use((error, request, response, next) => response.status(500).json({ error: 'x' }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `/api/admin/readers${path}`, method, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  } finally { server.close(); server.closeAllConnections?.(); }
}

test('only the main admin can edit or delete a reader', async () => {
  for (const role of ['country_admin', 'province_admin', 'city_admin', 'domain_user']) {
    const pool = fakePool();
    assert.equal((await call(pool, role, 'PATCH', '/users/7', { first_name: 'x' })).status, 403, `${role} PATCH`);
    assert.equal((await call(pool, role, 'DELETE', '/users/7')).status, 403, `${role} DELETE`);
    assert.equal(pool.writes.length, 0, `${role} wrote nothing`);
  }
});

test('the main admin edits the profile; the phone number is fixed and the audit row carries no personal data', async () => {
  const pool = fakePool();
  const done = await call(pool, 'super_admin', 'PATCH', '/users/7', { first_name: 'محمد', last_name: 'کریمی', is_student: true, student_no: '۴۰۰۱۲۳۴۶', unit_id: 6 });
  assert.equal(done.status, 200);
  const update = pool.writes.find((write) => write.sql.startsWith('UPDATE reader_users'));
  assert.deepEqual(update.params, ['محمد', 'کریمی', 1, '40012346', 6, 7]);
  assert.match(update.sql, /staff_user_id IS NULL/, 'a dashboard user’s linked account is never edited here');
  const audit = pool.writes.find((write) => write.sql.startsWith('INSERT INTO audit_log'));
  assert.match(audit.sql, /'reader\.user\.update'/);
  assert.ok(!audit.params.join('|').includes('40012346') && !audit.params.join('|').includes('9121234567'));
  assert.deepEqual(JSON.parse(audit.params[2]).changed.sort(), ['first_name', 'last_name', 'student_no', 'unit_id'].sort());
  assert.equal((await call(fakePool(), 'super_admin', 'PATCH', '/users/7', { phone: '+989120000000' })).status, 400);
});

test('edit validation: names, student number, hidden centre, unknown reader, duplicate student number', async () => {
  assert.equal((await call(fakePool(), 'super_admin', 'PATCH', '/users/7', { first_name: '' })).status, 400);
  assert.equal((await call(fakePool(), 'super_admin', 'PATCH', '/users/7', { is_student: 'yes' })).status, 400);
  assert.equal((await call(fakePool(), 'super_admin', 'PATCH', '/users/7', { is_student: true, student_no: '12' })).status, 400);
  assert.equal((await call(fakePool(), 'super_admin', 'PATCH', '/users/7', { unit_id: 99 })).status, 400, 'a hidden or unknown centre');
  assert.equal((await call(fakePool(), 'super_admin', 'PATCH', '/users/8', { first_name: 'x' })).status, 404);
  assert.equal((await call(fakePool(), 'super_admin', 'PATCH', '/users/abc', { first_name: 'x' })).status, 400);
  assert.equal((await call(fakePool({ duplicateStudentNo: true }), 'super_admin', 'PATCH', '/users/7', { student_no: '40099999' })).status, 409);
  // A reader who stops being a student loses the number.
  const pool = fakePool();
  assert.equal((await call(pool, 'super_admin', 'PATCH', '/users/7', { is_student: false })).status, 200);
  assert.deepEqual(pool.writes.find((write) => write.sql.startsWith('UPDATE reader_users')).params.slice(2, 4), [0, null]);
  // Keeping the reader's own (since hidden) centre is allowed.
  assert.equal((await call(fakePool({ visibleUnits: [] }), 'super_admin', 'PATCH', '/users/7', { first_name: 'سارا' })).status, 200);
});

test('the main admin deletes a reader; a missing one is 404', async () => {
  const pool = fakePool();
  assert.equal((await call(pool, 'super_admin', 'DELETE', '/users/7')).status, 200);
  assert.ok(pool.writes.some((write) => /^DELETE FROM reader_users WHERE id = \? AND staff_user_id IS NULL$/.test(write.sql)));
  assert.ok(pool.writes.some((write) => write.sql.startsWith('INSERT INTO audit_log') && /'reader\.user\.delete'/.test(write.sql)));
  assert.equal((await call(fakePool(), 'super_admin', 'DELETE', '/users/8')).status, 404);
  assert.equal((await call(fakePool(), 'super_admin', 'DELETE', '/users/0')).status, 400);
});
