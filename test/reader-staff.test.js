import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashToken } from '../src/auth/sessions.js';
import { splitFullName, staffPlace, staffRoleLabel } from '../src/lib/staff-reader.js';
import { withReaderApp } from './helpers/reader-app.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const read = (relative) => readFileSync(`${root}${relative}`, 'utf8');

const CITY_ADMIN = { staff_id: 11, full_name: 'علی رضایی مقدم', role: 'city_admin', region_id: 51, domain_name: null, level: 'city', region_name: 'تهران جنوب', parent_name: 'تهران' };
const signIn = (db, token, staff) => { db.staffSessions.set(hashToken(token).toString('hex'), { ...staff }); return `pnu_session=${token}`; };

test('a signed-in dashboard user is a reader too: a linked account with no phone, made once, with the post and the place', async () => {
  await withReaderApp({}, async ({ db, call }) => {
    const cookie = signIn(db, 'staff-token-1', CITY_ADMIN);
    const first = await call('/api/reader/me', { cookie });
    assert.equal(first.status, 200);
    assert.equal(first.json.user.phone, null);
    assert.equal(first.json.user.first_name, 'علی');
    assert.equal(first.json.user.last_name, 'رضایی مقدم');
    assert.equal(first.json.user.unit_id, 51);
    assert.deepEqual(first.json.user.staff, { role_label: 'مدیر مرکز دانشگاهی', domain: null, place: 'تهران جنوب، تهران' });
    assert.ok(!first.cookie, 'no reader cookie and no reader session: the identity follows the dashboard session');
    assert.equal(db.sessions.length, 0);
    const again = await call('/api/reader/me', { cookie });
    assert.equal(again.json.user.id, first.json.user.id);
    assert.equal(db.users.length, 1, 'one linked account per user, never a second');
    assert.equal(db.users[0].staff_user_id, 11);
  });
});

test('no dashboard session, an unknown or ended one (inactive or signed out) is not a reader', async () => {
  await withReaderApp({}, async ({ db, call }) => {
    assert.equal((await call('/api/reader/me')).json.user, null);
    assert.equal((await call('/api/reader/me', { cookie: 'pnu_session=never-issued' })).json.user, null);
    const cookie = signIn(db, 'staff-token-2', CITY_ADMIN);
    assert.ok((await call('/api/reader/me', { cookie })).json.user);
    db.staffSessions.clear(); // signed out, expired or deactivated: the session query finds nothing
    assert.equal((await call('/api/reader/me', { cookie })).json.user, null);
    assert.equal(db.sessions.length, 0);
  });
});

test('the card: post, domain and place for every kind of dashboard user', () => {
  assert.equal(staffRoleLabel('super_admin'), 'مدیر ارشد');
  assert.equal(staffRoleLabel('country_admin'), 'روابط عمومی سازمان مرکزی');
  assert.equal(staffRoleLabel('province_admin'), 'مدیر استان');
  assert.equal(staffRoleLabel('city_admin'), 'مدیر مرکز دانشگاهی');
  assert.equal(staffRoleLabel('domain_user', 'فناوری اطلاعات'), 'کاربر حوزه فناوری اطلاعات');
  assert.equal(staffRoleLabel('domain_user'), 'کاربر حوزه');
  assert.equal(staffRoleLabel('something_new'), 'مدیر');
  assert.equal(staffPlace({ level: 'city', region_name: 'تهران جنوب', parent_name: 'تهران' }), 'تهران جنوب، تهران');
  assert.equal(staffPlace({ level: 'province', region_name: 'فارس', parent_name: 'ایران' }), 'استان فارس');
  assert.equal(staffPlace({ level: 'country', region_name: 'ایران', parent_name: null }), 'سازمان مرکزی');
  assert.deepEqual(splitFullName('  علی   رضایی  مقدم '), { first: 'علی', last: 'رضایی مقدم' });
  assert.deepEqual(splitFullName('علی'), { first: 'علی', last: '' });
  assert.deepEqual(splitFullName(''), { first: 'مدیر', last: '' });
});

test('a domain user and a province admin get their own post and place', async () => {
  await withReaderApp({}, async ({ db, call }) => {
    const domain = signIn(db, 't-domain', { ...CITY_ADMIN, staff_id: 12, role: 'domain_user', domain_name: 'فناوری اطلاعات' });
    const province = signIn(db, 't-province', { staff_id: 13, full_name: 'سارا احمدی', role: 'province_admin', region_id: 5, domain_name: null, level: 'province', region_name: 'فارس', parent_name: 'ایران' });
    assert.deepEqual((await call('/api/reader/me', { cookie: domain })).json.user.staff, { role_label: 'کاربر حوزه فناوری اطلاعات', domain: 'فناوری اطلاعات', place: 'تهران جنوب، تهران' });
    assert.deepEqual((await call('/api/reader/me', { cookie: province })).json.user.staff, { role_label: 'مدیر استان', domain: null, place: 'استان فارس' });
    assert.equal(db.users.length, 2);
  });
});

test('the linked account follows the user: a changed name or unit is picked up on the next visit', async () => {
  await withReaderApp({}, async ({ db, call }) => {
    const cookie = signIn(db, 't-sync', CITY_ADMIN);
    await call('/api/reader/me', { cookie });
    db.staffSessions.get(hashToken('t-sync').toString('hex')).full_name = 'علی احمدی';
    db.staffSessions.get(hashToken('t-sync').toString('hex')).region_id = 52;
    const next = await call('/api/reader/me', { cookie });
    assert.equal(next.json.user.last_name, 'احمدی');
    assert.equal(next.json.user.unit_id, 52);
    assert.equal(db.users.length, 1);
  });
});

test('an ordinary reader session comes first; a dashboard user with their own reader account keeps it', async () => {
  await withReaderApp({}, async ({ db, call }) => {
    db.users.push({ id: 90, phone: '+989121234567', first_name: 'مریم', last_name: 'کریمی', is_student: 0, student_no: null, unit_id: 51 });
    db.sessions.push({ id: 1, user_id: 90, token_hash: null });
    const staff = signIn(db, 't-both', CITY_ADMIN);
    const alone = await call('/api/reader/me', { cookie: staff });
    assert.equal(alone.json.user.staff.role_label, 'مدیر مرکز دانشگاهی');
  });
});

test('the profile of a dashboard user cannot be edited on the news page; signing out of the reader does not end it', async () => {
  await withReaderApp({}, async ({ db, call }) => {
    const cookie = signIn(db, 't-patch', CITY_ADMIN);
    const patch = await call('/api/reader/me', { method: 'PATCH', body: { first_name: 'تغییر', last_name: 'نام', is_student: false, student_no: '', unit_id: 51 }, cookie });
    assert.equal(patch.status, 403);
    assert.equal(patch.json.code, 'staffProfile');
    assert.match(patch.json.error, /داشبورد/);
    assert.equal(db.users[0]?.first_name ?? 'علی', 'علی');
    assert.equal((await call('/api/reader/auth/logout', { method: 'POST', body: {}, cookie })).status, 200);
    assert.ok((await call('/api/reader/me', { cookie })).json.user, 'the dashboard session is untouched');
  });
});

test('the list and the counts of readers in the panel never include dashboard users; the migration links and cascades', () => {
  const admin = read('src/routes/readers-admin.js');
  assert.match(admin, /WHERE u\.staff_user_id IS NULL/);
  assert.match(admin, /FROM reader_users WHERE staff_user_id IS NULL/);
  const migration = read('migrations/2026112501_staff_reader_accounts.sql');
  assert.match(migration, /MODIFY phone VARCHAR\(16\) NULL/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS staff_user_id/);
  assert.match(migration, /ADD UNIQUE KEY IF NOT EXISTS uq_reader_staff_user/);
  assert.match(migration, /FOREIGN KEY IF NOT EXISTS \(staff_user_id\) REFERENCES users\(id\) ON DELETE CASCADE/);
});

test('the news page: the card shows post, name and place; the profile is a read-only card with a dashboard link and no sign-out', () => {
  const app = read(`public/reader/app.v${version}.js`);
  const module = read(`public/shared/reader-account.v${version}.js`);
  const card = app.slice(app.indexOf('function paintAccountCard'), app.indexOf('function syncAccountUi'));
  assert.match(card, /if \(user\.staff\) return paintStaffCard\(user\);/);
  for (const part of ['user.staff.role_label', 'user.staff.domain', 'user.staff.place', 'user.first_name']) assert.ok(card.includes(part), part);
  const staffCard = card.slice(card.indexOf('function paintStaffCard'));
  assert.ok(!staffCard.includes('accountPhoneText'), 'the post replaces the phone line');
  const template = module.slice(module.indexOf('function staffProfileTemplate'), module.indexOf('function render(next'));
  for (const text of ['سمت', 'حوزه', 'محل خدمت', 'نام', 'href="/dashboard/"', 'رفتن به داشبورد', 'نیازی به ورود دوباره نیست']) assert.ok(template.includes(text), text);
  assert.ok(!template.includes('data-logout') && !template.includes('<form') && !template.includes('<input'), 'nothing to edit, nothing to sign out of');
  assert.ok(!/\sstyle=|<script|\son[a-z]+=/i.test(template));
  assert.match(module, /profile: user\?\.staff \? staffProfileTemplate\(user\) : `/);
});
