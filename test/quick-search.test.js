import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const html = readFileSync(`${root}public/index.html`, 'utf8');
const script = readFileSync(`${root}public/reader/app.v${version}.js`, 'utf8');
const styles = readFileSync(`${root}public/reader/styles.v${version}.css`, 'utf8');
const worker = readFileSync(`${root}public/sw.js`, 'utf8');
const { matchesQuery, normalizeSearch, parseQuery, searchKey } = await import(`${root}public/shared/quick-search.v${version}.js`);

test('a news item matches when every typed word is in its title or summary, in any order', () => {
  const title = 'زمان‌بندی آزمون‌های میان‌ترم نیمسال اول';
  const summary = 'کلاس‌ها و امتحانات در مراکز برگزار می‌شود';
  assert.equal(matchesQuery(parseQuery('آزمون میان‌ترم'), title, summary), true);
  assert.equal(matchesQuery(parseQuery('ترم آزمون'), title, summary), true, 'word order does not matter');
  assert.equal(matchesQuery(parseQuery('امتحانات'), title, summary), true, 'a word only in the summary counts');
  assert.equal(matchesQuery(parseQuery('شهریه'), title, summary), false);
  assert.equal(matchesQuery(parseQuery('آزمون شهریه'), title, summary), false, 'all words are required');
  assert.equal(matchesQuery(parseQuery('   '), title, summary), true, 'an empty query keeps every card');
  assert.equal(matchesQuery(parseQuery('آزمون'), title, undefined, null), true, 'a missing summary is fine');
});

test('Arabic letters, digits, half-spaces and diacritics do not stop a match', () => {
  assert.equal(matchesQuery(parseQuery('كلاس'), 'کلاس‌های جبرانی'), true, 'Arabic kaf');
  assert.equal(matchesQuery(parseQuery('دانشجويان'), 'اطلاعیه دانشجویان'), true, 'Arabic yeh');
  assert.equal(matchesQuery(parseQuery('1405'), 'نیمسال ۱۴۰۵'), true, 'Latin digits find Persian digits');
  assert.equal(matchesQuery(parseQuery('۱۴۰۵'), 'term 1405'), true);
  assert.equal(matchesQuery(parseQuery('میانترم'), 'آزمون میان‌ترم'), true, 'half-space typed as nothing');
  assert.equal(matchesQuery(parseQuery('میان ترم'), 'آزمون میان‌ترم'), true, 'half-space typed as a space');
  assert.equal(matchesQuery(parseQuery('ABC'), 'abc news'), true, 'case is ignored');
  assert.equal(searchKey('می‌شود'), searchKey('می شود'));
  assert.equal(normalizeSearch('  a   b '), 'a b');
});

test('the home page has the search button before the font buttons and a bar that starts hidden', () => {
  assert.match(html, /<button[^>]*id="search-button"[^>]*aria-expanded="false"[^>]*aria-controls="quick-search"[^>]*aria-label="[^"]+"/);
  assert.ok(html.indexOf('id="search-button"') < html.indexOf('class="font-controls"'), 'the search button comes before the font buttons');
  assert.ok(html.indexOf('id="search-button"') > html.indexOf('id="city-button"'));
  assert.match(html, /<div class="quick-search" id="quick-search"[^>]*hidden>/);
  for (const id of ['quick-search-input', 'quick-search-count', 'quick-search-close', 'search-empty']) assert.ok(html.includes(`id="${id}"`), id);
  assert.equal((html.match(/class="search-field"/g) ?? []).length, 1, 'the city picker keeps the only .search-field');
});

test('on phones the city picker is in the first header row and the search button leads the second row, before the font buttons', () => {
  const phone = styles.slice(styles.indexOf('@media(max-width:639px){\n  .header-inner{flex-wrap:wrap'));
  const order = (selector) => Number(new RegExp(`${selector.replace('.', '\\.')}\\{order:(\\d+)`).exec(phone)?.[1]);
  assert.equal(order('.city-button'), 1, 'beside the site name');
  assert.equal(order('.search-button'), 10);
  assert.equal(order('.font-controls'), 13);
  assert.ok(order('.search-button') > 9, 'after the line break item, so it is in row 2');
  assert.ok(order('.search-button') < order('.font-controls'));
});

test('the filter hides cards without touching the feed data, and keeps working while pages and live updates arrive', () => {
  assert.match(styles, /\.is-search-hidden\{display:none!important\}/);
  assert.match(script, /import \{[^}]*matchesQuery[^}]*\} from '\/shared\/quick-search\.v[\d.]+\.js'/);
  assert.match(script, /new MutationObserver\(scheduleSearchFilter\)\.observe\(feed, \{ childList: true \}\)/);
  assert.match(script, /new MutationObserver\(scheduleSearchFilter\)\.observe\(pinnedStrip, \{ childList: true \}\)/);
  const recycle = script.slice(script.indexOf('function recycleFeed'), script.indexOf('function restoreRecycled'));
  assert.match(recycle, /if \(state\.searchTokens\.length\) return;/, 'cards are not recycled while searching');
  assert.match(script, /if \(tokens\.length && !wasSearching\) restoreAllRecycled\(\)/);
  const load = script.slice(script.indexOf('async function loadMore'), script.indexOf('// ---------- Quick search'));
  assert.match(load, /scheduleSearchFilter\(\)/, 'a loaded page is filtered and the count updated');
});

test('the search is hidden inside an article and the shared module is cached by the service worker', () => {
  assert.match(script, /searchButton\.hidden = app\.hidden/);
  assert.match(script, /observe\(app, \{ attributes: true, attributeFilter: \['hidden'\] \}\)/);
  assert.ok(worker.includes(`'/shared/quick-search.v${version}.js'`));
});

test('while a search reads more pages no placeholder cards flash and no unmatched card is ever painted', () => {
  const load = script.slice(script.indexOf('async function loadMore'), script.indexOf('// ---------- Quick search'));
  assert.match(load, /if \(!state\.cursor \|\| !state\.searchTokens\.length\) showSkeletons\(/, 'later pages are read without skeleton cards while searching');
  assert.match(load, /if \(state\.searchTokens\.length && !cardMatchesSearch\(node, state\.searchTokens\)\) node\.classList\.add\('is-search-hidden'\);\s*feed\.append\(node\)/, 'a card that does not match is hidden before it enters the page');
  assert.match(script, /quickSearch\.classList\.toggle\('is-loading', searching && !settled\)/, 'a progress line shows that more pages are still being read');
  assert.match(styles, /\.quick-search\.is-loading \.quick-search-field::after\{[^}]*animation:quick-search-progress/);
  assert.match(styles, /prefers-reduced-motion:reduce\)\{\.quick-search\.is-loading/);
});

test('a search spaces its page requests and a "too many requests" answer is retried quietly, not shown', () => {
  const load = script.slice(script.indexOf('const SEARCH_PAGE_GAP'), script.indexOf('// ---------- Quick search'));
  assert.match(load, /const SEARCH_PAGE_GAP = \d{3,}/, 'there is a gap between the pages a search reads');
  assert.match(load, /if \(state\.searchTokens\.length && state\.cursor\) \{\s*const wait = lastPageAt \+ SEARCH_PAGE_GAP - Date\.now\(\)/);
  assert.match(script, /error\.status = response\.status;[\s\S]*error\.retryAfter = Number\(response\.headers\.get\('retry-after'\)\)/, 'getJson reports the status and Retry-After');
  assert.match(load, /const throttled = error\.status === 429;/);
  assert.match(load, /throttled && state\.searchTokens\.length \? ''/, 'no error text while a search is waiting for the server');
  assert.match(load, /error\.retryAfter \|\| 5/, 'the retry waits as long as the server asked');
});
