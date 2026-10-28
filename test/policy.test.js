import test from 'node:test';
import assert from 'node:assert/strict';
import { canViewNews, canEditNews, canPublishTo, canCreateUser, canManageUser, newsVisibilitySql } from '../src/auth/policy.js';

const regions = [
  { id: 1, parent_id: null, type: 'country' },
  { id: 10, parent_id: 1, type: 'province' }, { id: 11, parent_id: 1, type: 'province' },
  { id: 100, parent_id: 10, type: 'city' }, { id: 101, parent_id: 10, type: 'city' }, { id: 110, parent_id: 11, type: 'city' },
];
const sup = { id: 1, role: 'super_admin', region_id: 1 };
const country = { id: 2, role: 'country_admin', region_id: 1 };
const provA = { id: 3, role: 'province_admin', region_id: 10 };
const provB = { id: 4, role: 'province_admin', region_id: 11 };
const cityA1 = { id: 5, role: 'city_admin', region_id: 100 };
const cityA2 = { id: 6, role: 'city_admin', region_id: 101 };
const news = (creator) => ({ created_by: creator.id, created_by_role: creator.role, created_by_region_id: creator.region_id, created_by_is_active: 1 });
const opts = { regions };

test('nobody sees peers or superiors', () => {
  assert.equal(canViewNews(cityA1, news(cityA2), opts), false);
  assert.equal(canViewNews(cityA1, news(provA), opts), false);
  assert.equal(canViewNews(cityA1, news(sup), opts), false);
  assert.equal(canViewNews(provA, news(provB), opts), false);
  assert.equal(canViewNews(provA, news(country), opts), false);
  assert.equal(canViewNews(provA, news(sup), opts), false);
  assert.equal(canViewNews(country, news(sup), opts), false);
});

test('superiors see subordinates; everyone sees own', () => {
  assert.equal(canViewNews(provA, news(cityA1), opts), true);
  assert.equal(canViewNews(provB, news(cityA1), opts), false);
  assert.equal(canViewNews(country, news(provA), opts), true);
  assert.equal(canViewNews(country, news(cityA1), opts), false);
  assert.equal(canViewNews(cityA1, news(cityA1), opts), true);
  assert.equal(canViewNews(sup, news(cityA1), opts), true);
  assert.equal(canEditNews(country, news(provB), opts), true);
  assert.equal(canEditNews(country, news(cityA2), opts), false);
});

test('portal-imported news (created by the system super admin) is hidden from everyone else', () => {
  const imported = { ...news(sup), source_url: 'https://pnu.ac.ir/x' };
  assert.equal(canViewNews(cityA1, imported, opts), false);
  assert.equal(canViewNews(provA, imported, opts), false);
  assert.equal(canViewNews(country, imported, opts), false);
  assert.equal(canEditNews(country, imported, opts), false);
  assert.equal(canEditNews(sup, imported, opts), true);
});

test('country admin publishes to country and provinces only', () => {
  assert.equal(canPublishTo(country, regions[0], regions), true);
  assert.equal(canPublishTo(country, regions[1], regions), true);
  assert.equal(canPublishTo(country, regions[3], regions), false);
});

test('user management hierarchy', () => {
  assert.equal(canCreateUser(sup, 'country_admin', regions[0], regions), true);
  assert.equal(canCreateUser(provA, 'country_admin', regions[0], regions), false);
  assert.equal(canCreateUser(country, 'province_admin', regions[1], regions), true);
  assert.equal(canCreateUser(country, 'city_admin', regions[3], regions), false);
  assert.equal(canManageUser(country, provB, 'deactivate', regions), true);
  assert.equal(canManageUser(country, cityA1, 'deactivate', regions), false);
  assert.equal(canManageUser(provA, country, 'deactivate', regions), false);
  assert.equal(canManageUser(provA, cityA1, 'reset_2fa', regions), true);
});

test('sql visibility mirrors the policy', () => {
  assert.equal(newsVisibilitySql(sup, regions), null);
  assert.match(newsVisibilitySql(country, regions).sql, /province_admin/);
  assert.deepEqual(newsVisibilitySql(cityA1, regions), { sql: '(n.created_by = ?)', values: [5] });
  assert.equal(newsVisibilitySql(provA, regions).values.length, 3);
});
