import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const script = readFileSync(`${root}public/dashboard/dashboard.v${version}.js`, 'utf8');
const styles = readFileSync(`${root}public/dashboard/styles.v${version}.css`, 'utf8');

function render(args) {
  const start = script.indexOf('const PAGER_ARROW_PREVIOUS');
  const end = script.indexOf('function scrollToList');
  const code = `const faDigits = { format: (n) => String(n) };\n${script.slice(start, end)}\nreturn renderPager;`;
  const element = { innerHTML: '' };
  new Function(code)()(element, args);
  return element.innerHTML;
}

test('the pager draws its arrows instead of typing mirrored characters', () => {
  const html = render({ page: 2, pages: 5, total: 50, limit: 10 });
  assert.ok(!/[‹›]/.test(html), 'typed › / ‹ are mirrored in RTL text and pointed the wrong way');
  assert.equal((html.match(/<svg class="pager-arrow"/g) || []).length, 2);
});

test('"previous" has its arrow first (right edge, pointing right) and "next" has it last (left edge, pointing left)', () => {
  const html = render({ page: 2, pages: 5, total: 50, limit: 10 });
  const previous = html.match(/<button[^>]*data-page="1"[^>]*pager-step[^>]*>|<button[^>]*pager-step[^>]*data-page="1"[^>]*>([\s\S]*?)<\/button>/);
  const buttons = [...html.matchAll(/<button type="button" class="pager-button pager-step"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]);
  assert.equal(buttons.length, 2);
  assert.ok(buttons[0].startsWith('<svg') && buttons[0].includes('M9 6l6 6-6 6') && buttons[0].endsWith('<span>قبلی</span>'));
  assert.ok(buttons[1].startsWith('<span>بعدی</span>') && buttons[1].includes('M15 6l-6 6 6 6') && buttons[1].endsWith('</svg>'));
  assert.ok(previous);
});

test('the first page disables "previous" and the last page disables "next"', () => {
  assert.match(render({ page: 1, pages: 3, total: 30, limit: 10 }), /data-page="0" disabled>/);
  assert.match(render({ page: 3, pages: 3, total: 30, limit: 10 }), /data-page="4" disabled>/);
});

test('the step buttons lay the arrow and the word out in a row', () => {
  assert.match(styles, /\.pager-step\{display:inline-flex;align-items:center;/);
});
