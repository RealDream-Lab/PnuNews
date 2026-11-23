import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const read = (relative) => readFileSync(`${root}${relative}`, 'utf8');
const digits = await import(`${root}public/shared/digits.v${version}.js`);
const html = read('public/index.html');
const app = read(`public/reader/app.v${version}.js`);
const styles = read(`public/reader/styles.v${version}.css`);
const module = read(`public/shared/reader-account.v${version}.js`);
// The module imports by web path (/shared/...), which Node cannot load; its text is read from the source instead.
const account = { BENEFIT_TEXT: /export const BENEFIT_TEXT = '([^']+)';/.exec(module)?.[1] };
const versionPattern = version.replaceAll('.', '\\.');

test('Persian and Arabic-Indic digits become ASCII, and nothing else is touched', () => {
  assert.equal(digits.toAsciiDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
  assert.equal(digits.toAsciiDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
  assert.equal(digits.toAsciiDigits('ab۱c٢'), 'ab1c2');
  assert.equal(digits.toAsciiDigits(null), '');
  assert.equal(digits.onlyDigits('۴۰-۱۲ ab٣', 4), '4012');
});

test('the phone field holds the national form, whatever way the number was typed or pasted', () => {
  for (const input of ['09123456789', '۰۹۱۲۳۴۵۶۷۸۹', '+98 912 345 6789', '+989123456789', '989123456789', '00989123456789', '۰۰۹۸۹۱۲۳۴۵۶۷۸۹', '0912-345-6789', '(0912) 345 6789']) {
    assert.equal(digits.nationalPhone(input), '09123456789', input);
  }
  assert.equal(digits.nationalPhone('0912'), '0912', 'a number still being typed is left alone');
  assert.equal(digits.nationalPhone('98'), '98', 'two digits are not an international prefix yet');
  assert.equal(digits.nationalPhone('0912345678901234'), '09123456789', 'at most 11 digits');
  assert.equal(digits.isNationalPhone('09123456789'), true);
  for (const bad of ['', '0912', '9123456789', '08123456789', '091234567890', 'abc']) assert.equal(digits.isNationalPhone(bad), false, bad);
  assert.equal(digits.formatPhone('09123456789'), '۰۹۱۲ ۳۴۵ ۶۷۸۹', 'a number is shown with Persian digits');
  assert.equal(digits.formatPhone('0912'), '۰۹۱۲');
  assert.equal(digits.toFaDigits('کد 0912 abc'), 'کد ۰۹۱۲ abc');
  assert.equal(digits.toFaDigits(null), '');
  assert.equal(digits.codeDigits('۱۲۳ ۴۵۶۷'), '123456');
  assert.equal(digits.studentDigits(`${'۱'.repeat(20)}`), '1'.repeat(14));
});

// A tiny stand-in for an <input>: just what bindDigitField uses.
function fakeInput(value = '') {
  const listeners = {};
  const input = {
    value, selectionStart: value.length, selectionEnd: value.length,
    addEventListener: (type, handler) => { listeners[type] = handler; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    fire: (type, event = {}) => listeners[type]({ preventDefault() { event.prevented = true; }, ...event }),
  };
  return input;
}

test('typing converts the digits in place and keeps the caret; a paste is converted before any length limit can cut it', () => {
  const changes = [];
  const input = fakeInput();
  digits.bindDigitField(input, digits.nationalPhone, (value) => changes.push(value));
  input.value = '۰۹۱۲'; input.selectionStart = 4;
  input.fire('input');
  assert.equal(input.value, '۰۹۱۲', 'the field keeps showing Persian digits');
  assert.deepEqual(changes.slice(-1), ['0912'], 'but what it reports is plain 0-9');
  assert.equal(input.selectionStart, 4);
  input.value = '09x12'; input.selectionStart = 3; // a letter typed in the middle
  input.fire('input');
  assert.equal(input.value, '۰۹۱۲');
  assert.equal(input.selectionStart, 2, 'the caret stays where the reader was typing');

  const pasted = { prevented: false, clipboardData: { getData: () => '+98 912 345 6789' } };
  const empty = fakeInput('');
  digits.bindDigitField(empty, digits.nationalPhone);
  empty.fire('paste', pasted);
  assert.equal(pasted.prevented, true, 'the browser does not paste it its own way');
  assert.equal(empty.value, '۰۹۱۲۳۴۵۶۷۸۹');
  assert.deepEqual(changes.slice(-1), ['0912']);

  const middle = fakeInput('0912');
  middle.selectionStart = 4; middle.selectionEnd = 4;
  digits.bindDigitField(middle, digits.codeDigits);
  middle.fire('paste', { clipboardData: { getData: () => '۳۴۵۶۷۸۹' } });
  assert.equal(middle.value, '۰۹۱۲۳۴', 'a six-digit field stops at six');
});

test('the account button is in the header, hidden until the main admin switches reader signup on', () => {
  assert.match(html, /<button[^>]*class="icon-button account-button"[^>]*id="account-button"[^>]*hidden[^>]*aria-haspopup="dialog"/);
  assert.match(html, /<symbol id="icon-user"/);
  assert.ok(html.indexOf('id="saved-button"') < html.indexOf('id="account-button"') && html.indexOf('id="account-button"') < html.indexOf('class="icon-button theme-toggle"'));
  assert.match(app, /const enabled = state\.config\?\.reader\?\.signup_enabled === true;/);
  assert.match(app, /accountButton\.hidden = !\(enabled \|\| signedIn\);/, 'a signed-in reader keeps the button when signup is switched off');
  assert.match(app, /accountButton\.classList\.toggle\('is-signed-in', signedIn\)/);
  assert.match(app, /if \(state\.config && !readerChecked\)/, 'the question «am I signed in?» is asked once per visit, signup switch or not');
  assert.equal(app.split('syncAccountUi();').length - 1, 6, 'after the first config, after every refreshed config, after the answer of /me, after the two callbacks of the dialog, and when the sync finds the session gone');
  assert.match(app, /getJson\('\/api\/reader\/me'\)/);
});

test('the account screens are a separate module, loaded on the first tap only', () => {
  assert.match(app, new RegExp(`import\\('/shared/reader-account\\.v${versionPattern}\\.js'\\)`));
  assert.ok(!new RegExp(`^import .*reader-account`, 'm').test(app), 'not imported at the start');
  assert.ok(!new RegExp(`^import .*digits`, 'm').test(app));
  assert.match(app, /accountModule \?\?= import\(/);
  assert.match(app, /onDisabled: \(\) => \{ state\.config = \{ \.\.\.state\.config, reader: \{ signup_enabled: false \} \}; syncAccountUi\(\); \}/);
});

test('the phone and code fields open a numeric keyboard, the code field takes the SMS autofill, and the benefit text is one paragraph', () => {
  assert.match(module, /name="phone" type="tel" inputmode="numeric" autocomplete="tel-national" dir="ltr"/);
  assert.match(module, /name="code" type="text" inputmode="numeric" autocomplete="one-time-code"/);
  assert.match(module, /name="student_no" type="text" inputmode="numeric"/);
  assert.match(module, /bindDigitField\(phone, nationalPhone\)/);
  assert.match(module, /bindDigitField\(code, codeDigits/);
  assert.match(module, /bindDigitField\(studentNo, studentDigits\)/);
  assert.match(module, /requestSubmit\(\)/, 'the sixth digit sends the code');
  assert.equal(account.BENEFIT_TEXT, 'با ساختن حساب، دنیای خبری خودتان را بسازید: خبرهای دلخواه را نشان‌دار کنید و در هر دستگاهی دوباره پیدا کنید. اگر دانشجو هستید و شمارهٔ دانشجویی‌تان را وارد کنید، اطلاع‌رسانی‌های ویژهٔ مرکز و دانشگاه خودتان زودتر به دستتان می‌رسد و از قابلیت‌های شخصی‌سازی‌شدهٔ آینده نیز پیش از دیگران بهره‌مند می‌شوید. ثبت‌نام فقط چند لحظه طول می‌کشد و راهی است برای اینکه سامانه بیشتر به نیاز شما نزدیک شود.');
  assert.ok(!account.BENEFIT_TEXT.includes('\n') && !account.BENEFIT_TEXT.includes('کم‌تعداد'));
  assert.match(module, /<aside class="account-benefit">\$\{BENEFIT_TEXT\}<\/aside>/);
});

test('nothing typed by the reader or sent back by the server reaches the page as HTML', () => {
  // Every value that comes from the reader or the server and is put into a template goes through escapeHtml.
  const fromData = [...module.matchAll(/\$\{([^}]*(?:values\.|user\?\.|flow\.phone)[^}]*)\}/g)].map((match) => match[1]);
  assert.ok(fromData.length >= 6, 'the check finds the template values it is meant to check');
  // (numbers made with Number() and the option list, which escapes its own names, are the only other forms)
  assert.deepEqual(fromData.filter((expression) => !expression.includes('escapeHtml(') && !/^(Number\(|unitOptions\()/.test(expression.trim())), [], 'every inserted value goes through escapeHtml');
  assert.match(module, /label="\$\{escapeHtml\(province\.name\)\}"/);
  assert.match(module, /\$\{escapeHtml\(city\.name\)\}<\/option>/);
  // Messages (the server's included) only ever go in as text.
  assert.match(module, /box\.textContent = message \?\? ''/);
  assert.ok(!/(?:innerHTML|insertAdjacentHTML)[^;\n]*\b(?:message|error)\b/.test(module), 'a message is never put into innerHTML');
  assert.match(app, /toast\.textContent = /, 'the toast shows text, not markup');
});

test('the dialog is a bottom sheet on phones and a centred dialog elsewhere, and the button sits in the first header row', () => {
  assert.match(styles, /@media\(max-width:767px\)\{\s*\.account-dialog\{inset:auto 0 0;width:100%/);
  assert.match(styles, /\.account-dialog \.info-panel\{max-height:92vh;max-height:92dvh;overflow:auto;border-radius:22px 22px 0 0/);
  assert.match(styles, /\.account-field input,\.account-field select\{[^}]*font-size:1rem/, '16px inputs: no zoom when a field is focused on iOS');
  assert.match(styles, /\.account-code\{[^}]*direction:ltr/);
  assert.match(styles, /\.account-benefit\{[^}]*text-align:justify;text-justify:inter-word/, 'the benefit paragraph is justified');
  assert.match(styles, /\.account-switch input:focus-visible\+\.account-switch-track/, 'the switch shows keyboard focus');
  const phones = /@media\(max-width:639px\)\{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? '';
  assert.match(phones, /\.account-button\{order:2\}/, 'after the city picker, in row 1 (order 9 is the line break)');
});
