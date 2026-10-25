import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adminRegionIds,
  allowedPublishTargets,
  canCreateUser,
  canDeleteNews,
  canEditNews,
  canManageRegion,
  canManageUser,
  canPublishTo,
  canViewNews,
} from '../src/auth/policy.js';

const regions = [
  { id: 1, parent_id: null, type: 'country', name: 'کشور' },
  { id: 10, parent_id: 1, type: 'province', name: 'استان الف' },
  { id: 11, parent_id: 10, type: 'city', name: 'شهر الف' },
  { id: 12, parent_id: 10, type: 'city', name: 'شهر ب' },
  { id: 20, parent_id: 1, type: 'province', name: 'استان ب' },
  { id: 21, parent_id: 20, type: 'city', name: 'شهر ج' },
];
const users = {
  super: { id: 1, role: 'super_admin', region_id: 1 },
  provinceA: { id: 2, role: 'province_admin', region_id: 10 },
  provinceB: { id: 3, role: 'province_admin', region_id: 20 },
  cityA: { id: 4, role: 'city_admin', region_id: 11 },
  cityB: { id: 5, role: 'city_admin', region_id: 12 },
};

const targets = [
  ['country', regions[0]],
  ['own province', regions[1]],
  ['own city', regions[2]],
  ['peer city', regions[3]],
  ['other province', regions[4]],
  ['other city', regions[5]],
];

test('publishing policy is constrained for every role and target class', () => {
  const expected = {
    super: [true, true, true, true, true, true],
    provinceA: [false, true, true, true, false, false],
    provinceB: [false, false, false, false, true, true],
    cityA: [false, false, true, false, false, false],
    cityB: [false, false, false, true, false, false],
  };
  for (const [userName, user] of Object.entries(users)) {
    for (const [targetIndex, [targetName, target]] of targets.entries()) {
      assert.equal(canPublishTo(user, target, regions), expected[userName][targetIndex], `${userName} -> ${targetName}`);
    }
  }
  assert.deepEqual(allowedPublishTargets(users.cityA, regions).map((region) => region.id), [11]);
  assert.deepEqual(new Set(allowedPublishTargets(users.provinceA, regions).map((region) => region.id)), new Set([10, 11, 12]));
  assert.equal(canPublishTo(users.provinceA, 1, regions), false);
});

test('view policy lets city admins see their full province and country news only', () => {
  const news = [
    { origin_region_id: 1 },
    { origin_region_id: 10 },
    { origin_region_id: 11 },
    { origin_region_id: 12 },
    { origin_region_id: 20 },
    { origin_region_id: 21 },
  ];
  const expected = {
    super: [true, true, true, true, true, true],
    provinceA: [true, true, true, true, false, false],
    cityA: [true, true, true, true, false, false],
    cityB: [true, true, true, true, false, false],
    provinceB: [true, false, false, false, true, true],
  };
  for (const [userName, user] of Object.entries(users)) {
    for (const [newsIndex, item] of news.entries()) {
      assert.equal(canViewNews(user, item, regions), expected[userName][newsIndex], `${userName} sees origin ${item.origin_region_id}`);
    }
  }
  assert.deepEqual([...adminRegionIds(users.cityA, regions)].sort((a, b) => a - b), [1, 10, 11, 12]);
});

test('edit and delete policy distinguishes creator, subordinate, and peers', () => {
  const ownProvinceNews = { id: 100, origin_region_id: 10, created_by: 2, created_by_role: 'province_admin', created_by_region_id: 10 };
  const provincePeerNews = { id: 101, origin_region_id: 10, created_by: 99, created_by_role: 'province_admin', created_by_region_id: 10 };
  const cityAOwnNews = { id: 102, origin_region_id: 11, created_by: 4, created_by_role: 'city_admin', created_by_region_id: 11, created_by_is_active: 1 };
  const cityBNews = { id: 103, origin_region_id: 12, created_by: 5, created_by_role: 'city_admin', created_by_region_id: 12, created_by_is_active: 1 };
  const cityPeerNews = { id: 104, origin_region_id: 11, created_by: 40, created_by_role: 'city_admin', created_by_region_id: 11, created_by_is_active: 1 };
  const inactiveCityPeerNews = { ...cityPeerNews, created_by_is_active: 0 };
  const otherProvinceNews = { id: 105, origin_region_id: 21, created_by: 80, created_by_role: 'city_admin', created_by_region_id: 21, created_by_is_active: 1 };

  const cases = [
    [users.super, otherProvinceNews, false, true, true],
    [users.provinceA, ownProvinceNews, false, true, true],
    [users.provinceA, provincePeerNews, false, false, false],
    [users.provinceA, provincePeerNews, true, true, true],
    [users.provinceA, cityBNews, false, true, true],
    [users.cityA, cityAOwnNews, false, true, true],
    [users.cityA, cityBNews, false, false, false],
    [users.cityA, cityPeerNews, false, false, false],
    [users.cityA, cityPeerNews, true, true, true],
    [users.cityA, inactiveCityPeerNews, true, false, false],
    [users.cityA, otherProvinceNews, true, false, false],
  ];
  for (const [user, item, peerEditEnabled, canEdit, canDelete] of cases) {
    const options = { regions, peerEditEnabled };
    assert.equal(canEditNews(user, item, options), canEdit, `${user.role} edit news ${item.id} with peer=${peerEditEnabled}`);
    assert.equal(canDeleteNews(user, item, options), canDelete, `${user.role} delete news ${item.id} with peer=${peerEditEnabled}`);
  }
});

test('user creation and management enforce hierarchy and forbid self-management', () => {
  for (const action of ['view', 'patch', 'deactivate', 'activate', 'reset_password', 'reset_2fa']) {
    assert.equal(canManageUser(users.super, users.cityA, action, regions), true, `super admin ${action}`);
    assert.equal(canManageUser(users.provinceA, users.cityA, action, regions), true, `province admin ${action} in province`);
    assert.equal(canManageUser(users.provinceA, users.cityB, action, regions), true, `province admin ${action} for peer city`);
    assert.equal(canManageUser(users.provinceA, users.provinceB, action, regions), false, `province admin ${action} for peer province`);
    assert.equal(canManageUser(users.cityA, users.cityB, action, regions), false, `city admin ${action}`);
    assert.equal(canManageUser(users.super, users.super, action, regions), false, `self ${action}`);
  }

  assert.equal(canCreateUser(users.super, 'province_admin', regions[1], regions), true);
  assert.equal(canCreateUser(users.super, 'city_admin', regions[2], regions), true);
  assert.equal(canCreateUser(users.super, 'super_admin', regions[0], regions), false);
  assert.equal(canCreateUser(users.provinceA, 'city_admin', regions[3], regions), true);
  assert.equal(canCreateUser(users.provinceA, 'city_admin', regions[5], regions), false);
  assert.equal(canCreateUser(users.provinceA, 'province_admin', regions[1], regions), false);
  assert.equal(canCreateUser(users.cityA, 'city_admin', regions[2], regions), false);
  assert.equal(canManageRegion(users.super), true);
  assert.equal(canManageRegion(users.provinceA), false);
});
