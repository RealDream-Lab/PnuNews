import test from 'node:test';
import assert from 'node:assert/strict';
import { sortCategoriesByNewsCount } from '../src/news/category-order.js';

const names = (list) => sortCategoriesByNewsCount(list).map((item) => item.name);

test('categories with more news come first', () => {
  const list = [
    { id: 1, name: 'اطلاعیه', news_count: 2 },
    { id: 2, name: 'اخبار', news_count: 9 },
    { id: 3, name: 'رویداد', news_count: 5 },
  ];
  assert.deepEqual(names(list), ['اخبار', 'رویداد', 'اطلاعیه']);
});

test('equal counts are ordered alphabetically in Persian', () => {
  const list = [
    { id: 1, name: 'ورزشی', news_count: 3 },
    { id: 2, name: 'آموزشی', news_count: 3 },
    { id: 3, name: 'پژوهشی', news_count: 3 },
    { id: 4, name: 'اطلاعیه', news_count: 3 },
    { id: 5, name: 'فرهنگی', news_count: 3 },
  ];
  assert.deepEqual(names(list), ['آموزشی', 'اطلاعیه', 'پژوهشی', 'فرهنگی', 'ورزشی']);
});

test('categories without news go last (alphabetical) and counts may arrive as strings', () => {
  const list = [
    { id: 1, name: 'ب', news_count: '0' },
    { id: 2, name: 'الف', news_count: 0 },
    { id: 3, name: 'ج', news_count: '4' },
  ];
  assert.deepEqual(names(list), ['ج', 'الف', 'ب']);
});

test('the input array is not modified', () => {
  const list = [{ id: 1, name: 'ب', news_count: 1 }, { id: 2, name: 'الف', news_count: 2 }];
  sortCategoriesByNewsCount(list);
  assert.equal(list[0].id, 1);
});
