const digitMap = new Map([
  ...Array.from('۰۱۲۳۴۵۶۷۸۹', (digit, index) => [digit, String(index)]),
  ...Array.from('٠١٢٣٤٥٦٧٨٩', (digit, index) => [digit, String(index)]),
]);

export function normalizeFa(value) {
  return String(value ?? '')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[٠-٩۰-۹]/g, (digit) => digitMap.get(digit))
    .replace(/ـ/g, '')
    .replace(/[\u200c\u200e\u200f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cleans user-visible Persian text without destroying typography: unlike normalizeFa
// (meant for search keys) it keeps half-spaces (ZWNJ) and the digits the author typed.
export function cleanFaText(value) {
  return String(value ?? '')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ـ/g, '')
    .replace(/[\u0000-\u001f\u007f\u200e\u200f]/g, ' ')
    .replace(/\u200c{2,}/g, '\u200c')
    .replace(/ *\u200c */g, '\u200c')
    .replace(/[ \t]+/g, ' ')
    .replace(/^[\s\u200c]+|[\s\u200c]+$/g, '');
}

export function buildSearchText(...values) {
  return normalizeFa(values.filter((value) => value != null).join(' '));
}

// The university's name is written with a half-space: "پیام نور" / "پیامنور" -> "پیام‌نور".
// This is applied to OUTPUT only (API responses, server-rendered HTML): nothing is rewritten in the database.
// The lookarounds keep other words intact ("پیام نوروز", "پیام نورانی"); the function is idempotent.
// Letters only (not punctuation such as the Persian comma), so "پیام نور،" still matches.
const BRAND_NAME = /(?<![\u0621-\u064A\u0671-\u06D3])پ[یي]ام[ \t\u00a0\u200c]*نور(?![\u0621-\u064A\u0671-\u06D3])/g;

export function normalizeBrandName(value) {
  return String(value ?? '').replace(BRAND_NAME, 'پیام\u200cنور');
}

// Walks a JSON-like value and returns a copy whose strings use the half-space spelling.
// Keys listed in skipKeys are left alone (HTML fields are filtered by the HTML sanitizer, text nodes only).
export function normalizeBrandDeep(value, skipKeys = ['body_html']) {
  if (typeof value === 'string') return normalizeBrandName(value);
  if (Array.isArray(value)) return value.map((item) => normalizeBrandDeep(item, skipKeys));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = skipKeys.includes(key) ? item : normalizeBrandDeep(item, skipKeys);
    return result;
  }
  return value;
}
