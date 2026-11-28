import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const html = readFileSync(`${root}public/dashboard/index.html`, 'utf8');
const script = readFileSync(`${root}public/dashboard/dashboard.v${version}.js`, 'utf8');
const styles = readFileSync(`${root}public/dashboard/styles.v${version}.css`, 'utf8');
const view = html.slice(html.indexOf('<section id="readers-view"'), html.indexOf('<section id="audit-view"'));
const panel = script.slice(script.indexOf('// ---------- Reader accounts (the main admin only)'), script.indexOf('function entityLabel'));

test('the readers page is in the menu for the main admin only, before the settings, and hidden until it is chosen', () => {
  assert.match(html, /<button type="button" data-view="readers" data-super-only>\s*<svg class="icon"><use href="#admin-icon-user" \/><\/svg>حساب خوانندگان/);
  assert.ok(html.indexOf('data-view="readers"') < html.indexOf('data-view="settings"'));
  assert.match(view, /^<section id="readers-view" class="admin-view" data-panel="readers" hidden>/);
  assert.ok(!/data-view="readers"[^>]*mobile|id="mobile-nav"[^]*data-view="readers"/.test(html), 'it is a desktop page like the settings');
  assert.match(script, /if \(view === "readers" && state\.user\?\.role !== "super_admin"\) view = "dashboard";/, 'nobody else can open it by a link or a stale state');
  assert.match(script, /else if \(actualView === "readers"\) loadReaders\(\);/);
});

test('the page has the switch, the credit, the limits, the failures, the search and the list; editing and deleting a reader are buttons drawn by the script, not controls in the page', () => {
  for (const id of ['readers-banner', 'readers-signup-switch', 'readers-signup-state', 'readers-credit', 'readers-refresh', 'readers-limits-form', 'readers-limits-error', 'readers-failures', 'readers-totals', 'readers-search', 'readers-list', 'readers-pager']) {
    assert.match(view, new RegExp(`id="${id}"`), id);
  }
  for (const name of ['sms_cost_rial', 'sms_min_remaining', 'sms_daily_cap']) assert.match(view, new RegExp(`name="${name}"\\s+inputmode="numeric"`), name);
  assert.match(view, /type="search"/);
  assert.ok(!/حذف|ویرایش|data-action|type="password"/.test(view.replace('ویرایش', '')) || !/حذف/.test(view), 'no delete control');
  assert.ok(!/حذف/.test(view) && !/data-action/.test(view), 'no action buttons on the reader rows');
  // The rows get an edit and a delete button (drawn by the script, main admin only: the whole view is data-super-only and the
  // server refuses every other role); the phone number is never sent back.
  assert.match(panel, /data-reader-action=\\?"edit\\?"/);
  assert.match(panel, /data-reader-action=\\?"delete\\?"/);
  assert.match(panel, /api\(`\/api\/admin\/readers\/users\/\$\{id\}`, \{ method: "PATCH", body: values \}\)/);
  assert.match(panel, /api\(`\/api\/admin\/readers\/users\/\$\{id\}`, \{ method: "DELETE", body: \{\} \}\)/);
  assert.ok(!/phone:/.test(panel.slice(panel.indexOf('function editReaderDialog'), panel.indexOf('async function handleReaderAction'))), 'the edit form never sends the phone number');
  assert.match(panel, /method: "PUT", body: \{ signup_enabled: wanted \}/);
});

test('what the server sends is shown as text; the list escapes every name, number and center', () => {
  assert.match(panel, /banner\.textContent = text;/);
  assert.ok(!/banner\.innerHTML/.test(panel));
  for (const field of ['`${item.first_name} ${item.last_name}`', 'readerPhone(item.phone)', 'item.unit.name', 'item.unit.province', 'toFaDigits(item.student_no)', 'toFaDigits(item.code)']) {
    assert.ok(panel.includes(`escapeHtml(${field}`) || panel.includes(`escapeHtml(${field})`), field);
  }
  assert.match(panel, /escapeHtml\(readerPhone\(item\.phone\)\)/);
  assert.match(panel, /escapeHtml\(toFaDigits\(item\.code\) \|\| "—"\)/);
  assert.match(panel, /escapeHtml\(readerSmsError\(status\.credit_error\)\)/);
  assert.match(panel, /escapeHtml\(query\)/);
});

test('the search waits 300 ms after the last key, and an older answer never replaces a newer one', () => {
  assert.match(panel, /searchTimer = setTimeout\(\(\) => loadReaderUsers\(1\), 300\);/);
  assert.match(panel, /clearTimeout\(searchTimer\)/);
  assert.match(panel, /const ticket = \(state\.readersTicket = \(state\.readersTicket \?\? 0\) \+ 1\);/);
  assert.match(panel, /if \(ticket !== state\.readersTicket\) return;/);
  assert.match(script, /"readers-pager": \(page\) => loadReaderUsers\(page\),/);
  assert.match(script, /initReadersPanel\(\);\s*const pagerHandlers = \{/);
});

test('turning signup on while ippanel is not set up asks first; the credit, the estimate and the automatic switch-off are explained', () => {
  assert.match(panel, /if \(wanted && state\.readerStatus && !state\.readerStatus\.configured && state\.readerSettings\?\.auth_method !== \"sms_receive\"\)/);
  assert.match(panel, /title: "ippanel تنظیم نشده است"/);
  assert.match(panel, /info\.reason === "low_credit"/);
  assert.match(panel, /info\.reason === "send_failures"/);
  assert.match(panel, /api\(`\/api\/admin\/readers\/sms-status\$\{refresh \? "\?refresh=1" : ""\}`\)/);
  assert.match(panel, /status\.remaining < status\.min_remaining\s*\? "danger"\s*: status\.remaining < status\.min_remaining \* 2\s*\? "warning"\s*: "ok"/);
  assert.match(panel, /Math\.floor\(rial \/ 10\)\)\} تومان/, 'toman next to rial');
});

test('the event log knows the new events, and the page works on a narrow screen', () => {
  assert.match(script, /"reader\.settings\.update": "تغییر تنظیمات حساب خوانندگان"/);
  assert.match(script, /"reader\.signup\.auto_disabled": "خاموش‌شدن خودکار ثبت‌نام خوانندگان"/);
  assert.match(script, /reader_settings: "حساب خوانندگان"/);
  assert.match(styles, /\.readers-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media\(max-width:900px\)\{\.readers-grid\{grid-template-columns:1fr\}\.readers-col\{display:contents\}\}/);
  // two stacks, not one grid of rows: a short card never waits for the tall card beside it, so no gap opens between cards
  assert.match(styles, /\.readers-col\{display:grid;gap:1rem;align-content:start/);
  const columns = [...view.matchAll(/<div class="readers-col">([^]*?)\n              <\/div>/g)].map((match) => match[1]);
  assert.equal(columns.length, 2);
  assert.ok(columns[0].includes('readers-signup-title') && columns[0].includes('readers-limits-form'), 'switch and limits share a column');
  assert.ok(columns[1].includes('readers-credit-title') && columns[1].includes('readers-failures-title'), 'credit and failures share a column');
  assert.match(styles, /\.readers-card-1\{order:1\}\.readers-card-2\{order:2\}\.readers-card-3\{order:3\}\.readers-card-4\{order:4\}/, 'on a narrow screen the original order is kept');
  assert.match(styles, /\.notice-banner\[data-level=danger\]/);
  assert.match(styles, /\.readers-search label\{max-width:26rem\}/);
});
