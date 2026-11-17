// Search helpers shared by the city picker and the quick news search. Pure functions: no DOM, no network.

// Makes Persian/Arabic spellings comparable: Arabic ي/ك/ة and hamza forms, diacritics, tatweel, Arabic-Indic and
// Persian digits, zero-width marks (half-space) and runs of spaces all collapse to one plain form.
export function normalizeSearch(value) {
  return String(value ?? '').toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x6f0))
    .replace(/ـ/g, '').replace(/[\u200c\u200e\u200f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Same, with every space removed, so "می‌شود", "می شود" and "میشود" are all the same text.
export function searchKey(value) {
  return normalizeSearch(value).replace(/ /g, '');
}

// What the reader typed → the words every result must contain (none = no search).
export function parseQuery(value) {
  return normalizeSearch(value).split(' ').filter(Boolean);
}

// A news item matches when every word of the query appears in its title or its summary (order does not matter).
export function matchesQuery(tokens, ...fields) {
  if (!tokens.length) return true;
  const text = searchKey(fields.filter(Boolean).join(' '));
  return tokens.every((token) => text.includes(token));
}
