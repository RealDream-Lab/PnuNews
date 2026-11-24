import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const read = (relative) => readFileSync(`${root}${relative}`, 'utf8');
const module = read(`public/shared/reader-account.v${version}.js`);
const app = read(`public/reader/app.v${version}.js`);
const styles = read(`public/reader/styles.v${version}.css`);
const html = read('public/dashboard/index.html');
const dashboard = read(`public/dashboard/dashboard.v${version}.js`);
const dashStyles = read(`public/dashboard/styles.v${version}.css`);
const view = html.slice(html.indexOf('<section id="readers-view"'), html.indexOf('<section id="audit-view"'));

// The module imports by web path, which Node cannot load; the three pure helpers are taken out of its text and run.
const pure = (name) => {
  const match = new RegExp(`export function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(module);
  assert.ok(match, name);
  return new Function(`${match[0].replace('export function', 'function')}; return ${name};`)();
};
const buildSmsLink = pure('buildSmsLink');
const isIos = pure('isIos');
const hasTouch = pure('hasTouch');

test('the SMS link: «?body=» on Android, «&body=» on iOS, the text percent-encoded, built only from the server\'s answer', () => {
  const body = 'کد ورود به اخبار پیام‌نور: 483920';
  assert.equal(buildSmsLink('+985000262720', body, false), `sms:+985000262720?body=${encodeURIComponent(body)}`);
  assert.equal(buildSmsLink('+985000262720', body, true), `sms:+985000262720&body=${encodeURIComponent(body)}`);
  assert.match(buildSmsLink('+985000262720', body, false), /%20|%3A/, 'the colon and spaces are encoded');
  for (const bad of [['5000262720', body], ['+98abc', body], ['+985000262720', ''], ['+985000262720', undefined], ['javascript:alert(1)', body], [undefined, body]]) {
    assert.equal(buildSmsLink(...bad, false), null, String(bad[0]));
  }
});

test('iPhone, iPad and an iPad that says it is a Mac are iOS; a desktop Mac and Android are not', () => {
  assert.equal(isIos({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 }), true);
  assert.equal(isIos({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)', platform: 'iPad', maxTouchPoints: 5 }), true);
  assert.equal(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 }), true, 'iPadOS');
  assert.equal(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 }), false);
  assert.equal(isIos({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', platform: 'Linux armv8l', maxTouchPoints: 5 }), false);
  assert.equal(isIos(undefined), false);
});

test('touch devices get the SMS button; a desktop does not', () => {
  assert.equal(hasTouch({}, { maxTouchPoints: 5 }), true);
  assert.equal(hasTouch({ ontouchstart: null }, { maxTouchPoints: 0 }), true);
  assert.equal(hasTouch({}, { maxTouchPoints: 0 }), false);
  assert.match(module, /const link = hasTouch\(\) \? buildSmsLink\(state\.line, state\.body, isIos\(\)\) : null;/);
  assert.match(module, /\$\{link \? `<a class="account-primary account-sms-link" data-sms-link href="\$\{escapeHtml\(link\)\}">ارسال پیامک<\/a>` : ''\}/);
});

test('the waiting step shows the line, the text and the number to send from, with copy buttons, always as text', () => {
  for (const text of ['کپی شماره', 'کپی متن پیام', 'data-copy="line"', 'data-copy="body"', 'شمارهٔ گیرنده', 'متن پیام', 'در انتظار پیامک شما', 'دریافت کد تازه', 'دو سیم‌کارت']) assert.ok(module.includes(text), text);
  assert.match(module, /پیامک باید از شمارهٔ <bdi dir="ltr">\$\{escapeHtml\(formatPhone\(flow\.phone\)\)\}<\/bdi> فرستاده شود/, 'the sending number is shown');
  assert.match(module, /toFaDigits\(state\.line \?\? ''\)/, 'people see Persian digits; the copy button copies the ASCII line');
  assert.match(module, /copy\.dataset\.copy === 'line' \? flow\.inbound\?\.line : flow\.inbound\?\.body/);
  assert.match(module, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(module, /document\.execCommand\('copy'\)/, 'a fallback for browsers without the clipboard API');
  assert.match(styles, /\.account-copy-sink\{/);
});

test('the answer of the server is drawn as escaped text, never as markup', () => {
  assert.match(module, /\$\{escapeHtml\(state\.body \?\? ''\)\}/);
  assert.ok(!/innerHTML\s*=\s*[^;]*answer\./.test(module));
});

test('polling: every 2.5 s while visible, at once on coming back, and it stops with the dialog, the step and the expiry', () => {
  assert.match(module, /const POLL_MS = 2500;/);
  assert.match(module, /api\('\/api\/reader\/auth\/inbound-status', \{ body: \{ handle: state\.handle \} \}\)/);
  assert.match(module, /if \(state\.done \|\| document\.hidden\) return;\s*state\.poll = setTimeout\(pollInbound, POLL_MS\);/, 'no question while the page is hidden');
  assert.match(module, /document\.addEventListener\('visibilitychange', state\.onVisible\)/);
  assert.match(module, /else \{ paintInboundLeft\(\); pollInbound\(\); \}/, 'back from the SMS app: ask at once');
  assert.match(module, /document\.removeEventListener\('visibilitychange', state\.onVisible\)/);
  assert.match(module, /dialog\.addEventListener\('close', \(\) => \{ stopTimer\(\); stopInbound\(\); \}\)/, 'closing the dialog stops it');
  assert.match(module, /if \(next !== 'inbound'\) stopInbound\(\);/, 'changing the step stops it');
  assert.match(module, /if \(flow\.inbound !== state \|\| state\.done\) return; \/\/ the dialog was closed/, 'a late answer is ignored');
  assert.match(module, /if \(answer\.status === 'expired'\) return showInboundExpired\(\);/);
  assert.match(module, /showInboundExpired\(\) \{[\s\S]*?clearInterval\(state\.tick\);\s*clearTimeout\(state\.poll\);/, 'expiry stops the timers');
  assert.match(module, /startTick[\s\S]*?await pollInbound\(\);/, 'one last question at zero');
  assert.match(module, /if \(answer\.status === 'confirmed'\) \{ stopInbound\(\); return inboundConfirmed\(answer\); \}/);
  assert.match(module, /inboundConfirmed[\s\S]*?answer\.needs_signup[\s\S]*?render\('signup'\)[\s\S]*?finish\(answer\.user/, 'the same ending as the code method');
});

test('the method comes from the public config; missing or unknown means the original, and a changed method is noticed', () => {
  assert.match(module, /const methodOf = \(\) => \(context\?\.authMethod === 'sms_receive' \? 'sms_receive' : 'sms_send'\);/);
  assert.match(module, /if \(methodOf\(\) === 'sms_receive'\) return requestInbound\(button\);/);
  assert.match(app, /authMethod: state\.config\?\.reader\?\.auth_method === 'sms_receive' \? 'sms_receive' : 'sms_send'/);
  assert.match(app, /reader: \{ \.\.\.state\.config\?\.reader, signup_enabled: false \}/, 'switching signup off keeps the rest of the reader config');
  assert.match(module, /error\.code === 'methodReceive'/);
  assert.match(module, /error\.code === 'methodSend'|failure\.code === 'methodSend'/);
  assert.match(module, /fetchOrExplain\('\/api\/public\/config'/);
});

test('the sms_send screens are the same as before', () => {
  for (const text of ['دریافت کد', 'ارسال دوباره کد', 'کد ۶ رقمی پیامک‌شده را وارد کنید.', '/api/reader/auth/request-code', '/api/reader/auth/verify']) assert.ok(module.includes(text), text);
});

test('Persian text for people, no inline script or style, nothing from outside', () => {
  const inboundPart = module.slice(module.indexOf('function inboundTemplate'), module.indexOf('function render(next'));
  assert.ok(!/\sstyle=|<script|\son[a-z]+=/i.test(inboundPart), 'no inline style, script or handler in the markup');
  assert.ok(!/\.setAttribute\('style'|cssText/.test(module));
  assert.ok(!/https?:\/\//.test(inboundPart));
  assert.match(inboundPart, /role="status" aria-live="polite"/, 'the waiting line is announced');
  assert.match(inboundPart, /role="alert"/);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)\{\.account-spinner\{animation:none\}\}/);
});

test('dashboard: a two-option choice with a Persian explanation of each, the line, the addresses and the webhook address with copy and a confirmed new key', () => {
  for (const id of ['readers-method-form', 'readers-inbound-fields', 'readers-webhook', 'readers-webhook-url', 'readers-webhook-copy', 'readers-key-rotate', 'readers-method-error', 'readers-inbound-log']) assert.match(view, new RegExp(`id="${id}"`), id);
  assert.match(view, /name="auth_method"\s+value="sms_send"/);
  assert.match(view, /name="auth_method"\s+value="sms_receive"/);
  assert.match(view, /ارسال کد از طرف ما \(پیش‌فرض\)/);
  assert.match(view, /ارسال پیامک از طرف خواننده/);
  assert.match(view, /هزینه‌ای برای هر ورود ندارد/);
  assert.match(view, /name="inbound_line"/);
  assert.match(view, /name="inbound_ips"/);
  assert.match(view, /id="readers-webhook-url"\s+type="text"\s+readonly/);
  assert.match(view, /id="readers-inbound-fields" hidden/, 'the extra settings show only when sms_receive is chosen');
  assert.match(dashboard, /"readers-inbound-fields"\)\.hidden = chosenMethod\(\) !== "sms_receive"/);
  assert.match(dashboard, /title: "ساخت کلید جدید"[\s\S]*?tone: "danger"/, 'a new key asks first');
  assert.match(dashboard, /if \(!sure\) return;\s*button\.disabled = true;\s*try \{\s*await api\("\/api\/admin\/readers\/inbound-key"/);
  assert.match(dashboard, /body\.inbound_line = normalizeDigits\(/);
  assert.match(dashboard, /"reader\.auth_method\.change": "تغییر روش ورود خوانندگان"/);
  assert.match(dashboard, /"reader\.inbound_key\.rotate"/);
  assert.match(dashStyles, /\.method-option:has\(input:focus-visible\)/, 'keyboard focus is visible');
});

test('dashboard: the log shows a masked number and a Persian reason; the webhook address is set as a field value, never as markup', () => {
  assert.match(dashboard, /field\.value = data\.webhook_url \?\? ""/);
  assert.ok(!/innerHTML[^;\n]*webhook_url/.test(dashboard));
  assert.match(dashboard, /escapeHtml\(READER_INBOUND_REASONS\[item\.reason\] \|\| "دلیل نامشخص"\)/);
  for (const reason of ['bad_key', 'wrong_method', 'ip_blocked', 'bad_sender', 'wrong_line', 'no_code', 'no_match', 'confirmed']) assert.match(dashboard, new RegExp(`\\b${reason}:`), reason);
});
