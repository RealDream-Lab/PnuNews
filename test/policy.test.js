import test from 'node:test';
import assert from 'node:assert/strict';
import { canViewNews, canEditNews, canDeleteNews, canPublishTo, canCreateUser, canManageUser, newsVisibilitySql, auditRegionIds } from '../src/auth/policy.js';

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
// Domain users (آموزش، امتحانات، …): one per domain per unit, working at the level of their unit.
const domCountry = { id: 20, role: 'domain_user', region_id: 1 };
const domProv = { id: 21, role: 'domain_user', region_id: 10 };
const domProvB = { id: 22, role: 'domain_user', region_id: 11 };
const domCity = { id: 23, role: 'domain_user', region_id: 100 };
const domCity2 = { id: 24, role: 'domain_user', region_id: 101 };

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

test('a unit admin supervises exactly the domain users of their own unit', () => {
  // own unit: view, edit and delete
  for (const [admin, domain] of [[country, domCountry], [provA, domProv], [cityA1, domCity]]) {
    assert.equal(canViewNews(admin, news(domain), opts), true);
    assert.equal(canEditNews(admin, news(domain), opts), true);
    assert.equal(canDeleteNews(admin, news(domain), opts), true);
  }
  // higher levels do not see the domain users below them, and units do not see each other
  assert.equal(canViewNews(country, news(domProv), opts), false);
  assert.equal(canViewNews(country, news(domCity), opts), false);
  assert.equal(canViewNews(provA, news(domCity), opts), false);
  assert.equal(canViewNews(provB, news(domProv), opts), false);
  assert.equal(canViewNews(cityA2, news(domCity), opts), false);
  assert.equal(canViewNews(provA, news(domCountry), opts), false);
  assert.equal(canViewNews(sup, news(domCity), opts), true);
});

test('a domain user sees and edits only their own news', () => {
  assert.equal(canViewNews(domCity, news(domCity), opts), true);
  assert.equal(canEditNews(domCity, news(domCity), opts), true);
  assert.equal(canViewNews(domCity, news(domCity2), opts), false);
  assert.equal(canViewNews(domCity, news(cityA1), opts), false);
  assert.equal(canViewNews(domProv, news(provA), opts), false);
  assert.equal(canViewNews(domCountry, news(country), opts), false);
  const imported = { ...news(sup), source_url: 'https://pnu.ac.ir/x' };
  assert.equal(canViewNews(domCountry, imported, opts), false);
  assert.equal(canDeleteNews(domCountry, imported, opts), false);
});

test('portal-imported news is shared by the main admin and the central PR, hidden from everyone else', () => {
  const imported = { ...news(sup), source_url: 'https://pnu.ac.ir/x' };
  assert.equal(canViewNews(cityA1, imported, opts), false);
  assert.equal(canViewNews(provA, imported, opts), false);
  assert.equal(canViewNews(country, imported, opts), true);
  assert.equal(canEditNews(country, imported, opts), false);
  assert.equal(canDeleteNews(country, imported, opts), true);
  assert.equal(canDeleteNews(provA, imported, opts), false);
  assert.equal(canEditNews(sup, imported, opts), true);
});

test('central PR publishes wherever the main admin does: country, provinces and cities', () => {
  for (const region of [regions[0], regions[1], regions[3]]) {
    assert.equal(canPublishTo(country, region, regions), true);
    assert.equal(canPublishTo(country, region, regions), canPublishTo(sup, region, regions));
  }
  // The narrower roles stay inside their own unit.
  assert.equal(canPublishTo(provA, regions[0], regions), false);
  assert.equal(canPublishTo(cityA1, regions[1], regions), false);
});

test('a domain user publishes exactly where the admin of the same level does', () => {
  for (const region of regions) {
    assert.equal(canPublishTo(domCountry, region, regions), canPublishTo(country, region, regions), `country ${region.id}`);
    assert.equal(canPublishTo(domProv, region, regions), canPublishTo(provA, region, regions), `province ${region.id}`);
    assert.equal(canPublishTo(domCity, region, regions), canPublishTo(cityA1, region, regions), `city ${region.id}`);
  }
  assert.equal(canPublishTo(domProv, regions[3], regions), true);
  assert.equal(canPublishTo(domProv, regions[5], regions), false);
  assert.equal(canPublishTo(domCity, regions[1], regions), false);
  // a domain user whose unit is unknown publishes nowhere
  assert.equal(canPublishTo({ id: 30, role: 'domain_user', region_id: 999 }, regions[0], regions), false);
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

test('unit admins create and manage the domain users of their own unit only', () => {
  assert.equal(canCreateUser(country, 'domain_user', regions[0], regions), true);
  assert.equal(canCreateUser(country, 'domain_user', regions[1], regions), false);
  assert.equal(canCreateUser(provA, 'domain_user', regions[1], regions), true);
  assert.equal(canCreateUser(provA, 'domain_user', regions[3], regions), false);
  assert.equal(canCreateUser(provB, 'domain_user', regions[1], regions), false);
  assert.equal(canCreateUser(cityA1, 'domain_user', regions[3], regions), true);
  assert.equal(canCreateUser(cityA1, 'domain_user', regions[4], regions), false);
  assert.equal(canCreateUser(cityA1, 'city_admin', regions[3], regions), false);
  // domain users create nobody
  for (const [domain, region] of [[domCountry, regions[0]], [domProv, regions[1]], [domCity, regions[3]]]) {
    assert.equal(canCreateUser(domain, 'domain_user', region, regions), false);
  }
  for (const action of ['view', 'patch', 'deactivate', 'activate', 'reset_password', 'reset_2fa', 'delete']) {
    assert.equal(canManageUser(country, domCountry, action, regions), true, action);
    assert.equal(canManageUser(provA, domProv, action, regions), true, action);
    assert.equal(canManageUser(cityA1, domCity, action, regions), true, action);
    assert.equal(canManageUser(country, domProv, action, regions), false, action);
    assert.equal(canManageUser(provA, domCity, action, regions), false, action);
    assert.equal(canManageUser(cityA2, domCity, action, regions), false, action);
    assert.equal(canManageUser(domCity, domCity2, action, regions), false, action);
  }
  assert.equal(canManageUser(sup, domCity, 'delete', regions), true);
});

test('sql visibility mirrors the policy', () => {
  assert.equal(newsVisibilitySql(sup, regions), null);
  assert.match(newsVisibilitySql(country, regions).sql, /province_admin/);
  assert.match(newsVisibilitySql(country, regions).sql, /source_url IS NOT NULL/);
  assert.doesNotMatch(newsVisibilitySql(provA, regions).sql, /source_url/);
  assert.deepEqual(newsVisibilitySql(domCity, regions), { sql: '(n.created_by = ?)', values: [23] });
  assert.deepEqual(newsVisibilitySql(cityA1, regions), {
    sql: `(n.created_by = ? OR (creator.role = 'domain_user' AND creator.region_id = ?))`,
    values: [5, 100],
  });
  // own news, the city admins of the province (2 cities) and the province's own domain users
  assert.deepEqual(newsVisibilitySql(provA, regions).values, [3, 100, 101, 10]);
  assert.match(newsVisibilitySql(provA, regions).sql, /creator\.role = 'domain_user' AND creator\.region_id = \?/);
  assert.deepEqual(newsVisibilitySql(country, regions).values, [2, 1]);
});

test('domain users have no audit-log scope', () => {
  assert.equal(auditRegionIds(domCity, regions).size, 0);
  assert.equal(auditRegionIds(domCountry, regions).size, 0);
  assert.deepEqual([...auditRegionIds(cityA1, regions)], [100]);
});
