const PERSIAN_EPOCH = 1_948_321;
const JALALI_CYCLE_DAYS = 1_029_983;
const JALALI_CYCLE_YEARS = 2_820;

export const JALALI_MONTHS = Object.freeze([
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
]);

function floorDiv(value, divisor) {
  return Math.floor(value / divisor);
}

function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function assertDateParts(year, month, day, label) {
  if (![year, month, day].every(Number.isInteger) || month < 1 || month > 12 || day < 1) {
    throw new RangeError(`${label} date parts are invalid.`);
  }
}

export function jalaliToJdn(year, month, day) {
  assertDateParts(year, month, day, 'Jalali');
  const monthLength = month <= 6 ? 31 : month <= 11 ? 30 : isJalaliLeapYear(year) ? 30 : 29;
  if (day > monthLength) throw new RangeError('Jalali day is outside its month.');
  const epochBase = year - (year >= 0 ? 474 : 473);
  const epochYear = 474 + mod(epochBase, JALALI_CYCLE_YEARS);
  const elapsedMonths = month <= 7 ? (month - 1) * 31 : (month - 1) * 30 + 6;
  return day + elapsedMonths + floorDiv(epochYear * 682 - 110, 2816) +
    (epochYear - 1) * 365 + floorDiv(epochBase, JALALI_CYCLE_YEARS) * JALALI_CYCLE_DAYS + PERSIAN_EPOCH - 1;
}

export function isJalaliLeapYear(year) {
  if (!Number.isInteger(year)) throw new RangeError('Jalali year must be an integer.');
  const epochBase = year - (year >= 0 ? 474 : 473);
  const epochYear = 474 + mod(epochBase, JALALI_CYCLE_YEARS);
  const nextBase = year + 1 - (year + 1 >= 0 ? 474 : 473);
  const nextEpochYear = 474 + mod(nextBase, JALALI_CYCLE_YEARS);
  const start = (epyear) => floorDiv(epyear * 682 - 110, 2816) + (epyear - 1) * 365;
  const cycleOffset = floorDiv(epochBase, JALALI_CYCLE_YEARS) * JALALI_CYCLE_DAYS;
  const nextCycleOffset = floorDiv(nextBase, JALALI_CYCLE_YEARS) * JALALI_CYCLE_DAYS;
  return nextCycleOffset + start(nextEpochYear) - cycleOffset - start(epochYear) === 366;
}

export function jalaliMonthLength(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError('Jalali year or month is invalid.');
  }
  if (month <= 6) return 31;
  if (month <= 11) return 30;
  return isJalaliLeapYear(year) ? 30 : 29;
}

export function jdnToGregorian(jdn) {
  if (!Number.isInteger(jdn)) throw new RangeError('Julian day number must be an integer.');
  const a = jdn + 32_044;
  const b = floorDiv(4 * a + 3, 146_097);
  const c = a - floorDiv(146_097 * b, 4);
  const d = floorDiv(4 * c + 3, 1_461);
  const e = c - floorDiv(1_461 * d, 4);
  const m = floorDiv(5 * e + 2, 153);
  const day = e - floorDiv(153 * m + 2, 5) + 1;
  const month = m + 3 - 12 * floorDiv(m, 10);
  const year = 100 * b + d - 4_800 + floorDiv(m, 10);
  return { year, month, day };
}

export function gregorianToJdn(year, month, day) {
  assertDateParts(year, month, day, 'Gregorian');
  const monthLength = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > monthLength) throw new RangeError('Gregorian day is outside its month.');
  const a = floorDiv(14 - month, 12);
  const y = year + 4_800 - a;
  const m = month + 12 * a - 3;
  return day + floorDiv(153 * m + 2, 5) + 365 * y + floorDiv(y, 4) - floorDiv(y, 100) + floorDiv(y, 400) - 32_045;
}

export function jalaliToGregorian(year, month, day) {
  return jdnToGregorian(jalaliToJdn(year, month, day));
}

export function gregorianToJalali(year, month, day) {
  const jdn = gregorianToJdn(year, month, day);
  let jalaliYear = year - 621;
  let newYearJdn = jalaliToJdn(jalaliYear, 1, 1);
  if (jdn < newYearJdn) {
    jalaliYear -= 1;
    newYearJdn = jalaliToJdn(jalaliYear, 1, 1);
  } else {
    const nextYearJdn = jalaliToJdn(jalaliYear + 1, 1, 1);
    if (jdn >= nextYearJdn) {
      jalaliYear += 1;
      newYearJdn = nextYearJdn;
    }
  }
  const dayOfYear = jdn - newYearJdn;
  const jalaliMonth = dayOfYear < 186 ? floorDiv(dayOfYear, 31) + 1 : floorDiv(dayOfYear - 186, 30) + 7;
  const jalaliDay = dayOfYear < 186 ? mod(dayOfYear, 31) + 1 : mod(dayOfYear - 186, 30) + 1;
  return { year: jalaliYear, month: jalaliMonth, day: jalaliDay };
}

export function jalaliDateToIsoDate(year, month, day) {
  const gregorian = jalaliToGregorian(year, month, day);
  return `${String(gregorian.year).padStart(4, '0')}-${String(gregorian.month).padStart(2, '0')}-${String(gregorian.day).padStart(2, '0')}`;
}
