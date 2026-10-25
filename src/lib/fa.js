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

export function buildSearchText(...values) {
  return normalizeFa(values.filter((value) => value != null).join(' '));
}
