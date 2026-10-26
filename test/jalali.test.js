import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gregorianToJalali,
  gregorianToJdn,
  isJalaliLeapYear,
  jalaliDateToIsoDate,
  jalaliMonthLength,
  jalaliToGregorian,
  jalaliToJdn,
  jdnToGregorian,
} from '../src/lib/jalali.js';

test('Jalali conversion matches Nowruz and Gregorian month-boundary vectors', () => {
  assert.deepEqual(jalaliToGregorian(1403, 1, 1), { year: 2024, month: 3, day: 20 });
  assert.deepEqual(gregorianToJalali(2024, 3, 20), { year: 1403, month: 1, day: 1 });
  assert.equal(jalaliDateToIsoDate(1403, 6, 31), '2024-09-21');
  assert.deepEqual(gregorianToJalali(2024, 9, 22), { year: 1403, month: 7, day: 1 });
  assert.equal(jalaliDateToIsoDate(1400, 1, 1), '2021-03-21');
});

test('Jalali leap years and month ends remain valid at Esfand boundaries', () => {
  assert.equal(isJalaliLeapYear(1399), true);
  assert.equal(isJalaliLeapYear(1400), false);
  assert.equal(isJalaliLeapYear(1403), false);
  assert.equal(jalaliMonthLength(1399, 12), 30);
  assert.equal(jalaliMonthLength(1400, 12), 29);
  assert.deepEqual(jalaliToGregorian(1399, 12, 30), { year: 2021, month: 3, day: 20 });
  assert.throws(() => jalaliToGregorian(1400, 12, 30), RangeError);
});

test('Gregorian and Jalali conversions round-trip across a complete year', () => {
  for (let month = 1; month <= 12; month += 1) {
    const day = jalaliMonthLength(1403, month);
    const gregorian = jalaliToGregorian(1403, month, day);
    assert.deepEqual(gregorianToJalali(gregorian.year, gregorian.month, gregorian.day), { year: 1403, month, day });
    assert.deepEqual(jdnToGregorian(gregorianToJdn(gregorian.year, gregorian.month, gregorian.day)), gregorian);
    assert.ok(jalaliToJdn(1403, month, day) > 0);
  }
});
