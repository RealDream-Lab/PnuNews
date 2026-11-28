import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const read = (relative) => readFileSync(`${root}${relative}`, 'utf8');
const html = read('public/index.html');
const app = read(`public/reader/app.v${version}.js`);
const styles = read(`public/reader/styles.v${version}.css`);

test('the header has no account button: the account lives in the first card of the strip', () => {
  const header = /<header class="site-header">[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
  assert.ok(header && !header.includes('account'), 'nothing about the account in the header');
  assert.match(app, /accountButton\.className = 'account-card is-guest'/);
});

test('the strip puts the account card first, before the prayer card, and shows the strip for it alone', () => {
  const sync = /function syncPrayerCard\(\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
  assert.match(sync, /const showAccount = !accountButton\.hidden;/);
  assert.match(sync, /const showPrayer = prayerPointer\.matches && prayerView;/);
  assert.match(sync, /const cards = \[showAccount && accountButton, showCalendar && calendarNode, showPrayer && prayerNode\]\.filter\(Boolean\);/, 'the account card is first, then the calendar card, then the mobile prayer card');
  assert.match(sync, /if \(pinnedStrip\.children\[index\] !== node\) pinnedStrip\.insertBefore\(node, pinnedStrip\.children\[index\] \?\? null\)/, 'every card is put at its place, so the account card is always first');
  assert.match(sync, /pinnedStrip\.hidden = !\(cards\.length \|\| pinnedStrip\.querySelector\('\[data-news-id\]'\)\)/);
});

test('the account card alone never hides the empty-feed message', () => {
  assert.ok(!/!pinnedStrip\.hidden\) \{/.test(app));
  assert.match(app, /state\.entries\.length \|\| pinnedStrip\.querySelector\('\[data-news-id\], \.prayer-card'\)/);
  assert.match(app, /!state\.entries\.length && !pinnedStrip\.querySelector\('\[data-news-id\], \.prayer-card'\)/);
});

test('signed out the card is only the person icon; signed in it has three lines: phone, name, centre', () => {
  const paint = /function paintAccountCard\(user\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
  assert.match(paint, /if \(!user\) \{\s*accountButton\.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-user"\/><\/svg>';/);
  const lines = [...paint.matchAll(/class="(account-[a-z-]+)/g)].map((match) => match[1]);
  assert.deepEqual(lines, ['account-line', 'account-name', 'account-unit'], 'phone, then name, then the centre under it');
  assert.match(app, /accountButton\.classList\.toggle\('is-guest', !signedIn\)/);
});

test('the phone shows in Persian digits and the centre comes from the config by unit id', () => {
  const phoneText = new Function(`${/const PERSIAN_DIGITS = [^\n]*\n/.exec(app)[0]}${/function accountPhoneText\(phone\) \{[\s\S]*?\n\}\n/.exec(app)[0]}return accountPhoneText;`)();
  assert.equal(phoneText('+989123456789'), '۰۹۱۲ ۳۴۵ ۶۷۸۹');
  assert.equal(phoneText('09123456789'), '۰۹۱۲ ۳۴۵ ۶۷۸۹');
  assert.equal(phoneText(null), '');
  const unit = new Function('state', `${/function accountUnitName\(unitId\) \{[\s\S]*?\n\}\n/.exec(app)[0]}return accountUnitName;`)({
    config: { provinces: [{ id: 1, name: 'کردستان', cities: [{ id: 7, name: 'بیجار' }, { id: 8, name: 'سنندج' }] }] },
  });
  assert.equal(unit(8), 'سنندج');
  assert.equal(unit('7'), 'بیجار');
  assert.equal(unit(99), '');
});

test('the card opens the same account dialog, and the styles give it the prayer card\'s look', () => {
  assert.match(app, /accountButton\.addEventListener\('click', async \(\) => \{\s*accountModule \?\?= import\(/);
  assert.match(styles, /\.account-card\{[^}]*flex:0 0 min\(215px,70%\)[^}]*cursor:pointer/);
  assert.match(styles, /\.account-card\.is-guest\{[^}]*flex:0 0 auto/);
  assert.match(styles, /\.account-card\[hidden\]\{display:none\}/);
});
