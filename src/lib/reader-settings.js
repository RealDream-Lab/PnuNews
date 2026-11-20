// Settings of the reader accounts and their SMS budget. They live in the `settings` table like the other site settings;
// a row that was never written (or was damaged by hand) falls back to the default here, so the migration does not need
// to insert any.
//
// The API talks in short names (`signup_enabled`); the table keys are the long ones.
export const READER_SETTING_DEFAULTS = Object.freeze({
  reader_signup_enabled: '0',
  sms_cost_rial: '2000',
  sms_min_remaining: '200',
  sms_daily_cap: '300',
});

const FIELDS = Object.freeze({
  signup_enabled: { key: 'reader_signup_enabled', kind: 'boolean', label: 'ثبت‌نام خوانندگان' },
  // What one pattern SMS is assumed to cost. The real price is a little lower (about 1,848 rial), so estimates stay on the safe side.
  sms_cost_rial: { key: 'sms_cost_rial', kind: 'integer', min: 100, max: 100_000, label: 'هزینهٔ هر پیامک (ریال)' },
  // Below this many SMS left (credit / cost), signup switches itself off.
  sms_min_remaining: { key: 'sms_min_remaining', kind: 'integer', min: 0, max: 100_000, label: 'حداقل پیامک باقی‌مانده' },
  sms_daily_cap: { key: 'sms_daily_cap', kind: 'integer', min: 1, max: 100_000, label: 'سقف روزانهٔ پیامک' },
});

export const READER_SETTING_KEYS = Object.freeze(Object.values(FIELDS).map((field) => field.key));

const faNumber = new Intl.NumberFormat('fa-IR');

function parseStored(field, raw) {
  if (field.kind === 'boolean') return raw === '1';
  const number = Number(raw);
  return Number.isInteger(number) && number >= field.min && number <= field.max ? number : Number(READER_SETTING_DEFAULTS[field.key]);
}

// rows: [{ k, v }] from the settings table. Always returns every field, filled from the defaults where needed.
export function readerSettingsFromRows(rows = []) {
  const stored = Object.fromEntries(rows.map((row) => [row.k, row.v]));
  return Object.fromEntries(Object.entries(FIELDS).map(([name, field]) => [name, parseStored(field, stored[field.key] ?? READER_SETTING_DEFAULTS[field.key])]));
}

export async function loadReaderSettings(pool) {
  const [rows] = await pool.query('SELECT k, v FROM settings WHERE k IN (?)', [READER_SETTING_KEYS]);
  return readerSettingsFromRows(rows);
}

// body: what the super admin's panel sent. Strict on purpose: unknown names, strings instead of numbers and
// out-of-range numbers are refused instead of being corrected.
export function validateReaderSettingsUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'تنظیمات ارسالی معتبر نیست.' };
  const names = Object.keys(body);
  if (!names.length || names.some((name) => !Object.hasOwn(FIELDS, name))) return { ok: false, error: 'تنظیمات ارسالی معتبر نیست.' };
  const values = {};
  for (const name of names) {
    const field = FIELDS[name];
    const value = body[name];
    if (field.kind === 'boolean') {
      if (typeof value !== 'boolean') return { ok: false, error: `مقدار «${field.label}» باید روشن یا خاموش باشد.` };
    } else if (!Number.isInteger(value) || value < field.min || value > field.max) {
      return { ok: false, error: `«${field.label}» باید عددی صحیح بین ${faNumber.format(field.min)} و ${faNumber.format(field.max)} باشد.` };
    }
    values[name] = value;
  }
  return { ok: true, values };
}

export function storedValue(name, value) {
  return FIELDS[name].kind === 'boolean' ? (value ? '1' : '0') : String(value);
}

export const readerSettingKey = (name) => FIELDS[name].key;
