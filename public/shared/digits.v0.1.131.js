// Digits and phone numbers typed on a Persian keyboard. Persian (۰-۹) and Arabic-Indic (٠-٩) digits become ASCII as the
// reader types or pastes, so the server (and the SMS) only ever see 0-9, and the phone keypad stays numeric.
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC = '٠١٢٣٤٥٦٧٨٩';

export function toAsciiDigits(value) {
  return String(value ?? '').replace(/[۰-۹٠-٩]/g, (digit) => {
    const persian = PERSIAN.indexOf(digit);
    return String(persian >= 0 ? persian : ARABIC.indexOf(digit));
  });
}

export const onlyDigits = (value, max = Infinity) => toAsciiDigits(value).replace(/\D/g, '').slice(0, max);

// What the phone field holds: the national form 09123456789 (11 digits at most). A pasted +98 912 345 6789, 0098912... or
// 98912... becomes the same national form; short input is left as typed so the reader can keep typing.
export function nationalPhone(value) {
  let digits = onlyDigits(value);
  if (digits.startsWith('0098')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('98') && digits.length >= 12) digits = `0${digits.slice(2)}`;
  return digits.slice(0, 11);
}

export const isNationalPhone = (value) => /^09\d{9}$/.test(value);
export const codeDigits = (value) => onlyDigits(value, 6);
export const studentDigits = (value) => onlyDigits(value, 14);

// 09123456789 -> 0912 345 6789 (for showing; the field itself holds the plain digits)
export function formatPhone(national) {
  const digits = String(national ?? '');
  return /^\d{11}$/.test(digits) ? `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}` : digits;
}

// Keeps an <input> normalised while the reader types and pastes. A paste is handled here (not by the browser) so a long
// pasted value such as +98 912 345 6789 is converted first and not cut at a length limit.
export function bindDigitField(input, normalize, onChange = () => {}) {
  const set = (next, caret) => {
    if (input.value !== next) input.value = next;
    try { input.setSelectionRange(caret, caret); } catch { /* some input types have no caret */ }
    onChange(next);
  };
  input.addEventListener('input', () => {
    const raw = input.value;
    const cleaned = normalize(raw);
    if (raw === cleaned) return onChange(cleaned);
    const caret = normalize(raw.slice(0, input.selectionStart ?? raw.length)).length;
    return set(cleaned, caret);
  });
  input.addEventListener('paste', (event) => {
    const pasted = event.clipboardData?.getData('text');
    if (typeof pasted !== 'string') return;
    event.preventDefault();
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const next = normalize(`${input.value.slice(0, start)}${pasted}${input.value.slice(end)}`);
    set(next, Math.min(next.length, normalize(`${input.value.slice(0, start)}${pasted}`).length));
  });
}
