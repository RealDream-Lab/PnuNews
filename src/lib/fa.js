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
