import assert from 'node:assert/strict';
import test from 'node:test';
import { compareUsersForTree, groupUsersForTree } from '../src/lib/user-tree.js';

const user = (id, role, regionType, regionId, parentId, regionName, extra = {}) => ({
  id, username: `u${id}`, role, region_type: regionType, region_id: regionId, parent_region_id: parentId,
  region_name: regionName, region_sort: regionId, parent_sort: parentId ?? regionId, domain_sort: 0, ...extra,
});

test('users are ordered country, then each province with its centers right under it', () => {
  const shuffled = [
    user(1, 'city_admin', 'city', 21, 2, 'ب'),
    user(2, 'province_admin', 'province', 3, 0, 'استان دوم'),
    user(3, 'city_admin', 'city', 11, 2, 'الف'),
    user(4, 'province_admin', 'province', 2, 0, 'استان اول'),
    user(5, 'country_admin', 'country', 1, null, 'کشور'),
    user(6, 'city_admin', 'city', 31, 3, 'ج'),
    user(7, 'domain_user', 'province', 2, 0, 'استان اول', { domain_sort: 1 }),
  ];
  const sorted = [...shuffled].sort(compareUsersForTree);
  assert.deepEqual(sorted.map((item) => item.id), [5, 4, 7, 3, 1, 2, 6]);
  const groups = groupUsersForTree(sorted);
  // every group is one province (or the country) and its centers; no center sits in another group
  for (const group of groups) {
    const groupIds = new Set(group.map((item) => (item.region_type === 'city' ? item.parent_region_id : item.region_id)));
    assert.equal(groupIds.size, 1);
  }
  assert.equal(groups.length, 3);
});
