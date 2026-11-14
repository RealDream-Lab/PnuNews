// ترتیب درختی فهرست کاربران: کشور، سپس هر استان (کاربران خود استان و بعد مراکز آن)، و در هر واحد مدیر پیش از کاربران حوزه.
const USER_ROLE_RANK = { super_admin: 0, country_admin: 1, province_admin: 2, city_admin: 3, domain_user: 4 };

function userGroupId(user) {
  return user.region_type === 'city' ? Number(user.parent_region_id) : Number(user.region_id);
}

export function compareUsersForTree(a, b) {
  const groupType = (user) => (user.region_type === 'country' ? 0 : 1);
  const groupSort = (user) => Number((user.region_type === 'city' ? user.parent_sort : user.region_sort) ?? 0);
  return groupType(a) - groupType(b)
    || groupSort(a) - groupSort(b)
    || userGroupId(a) - userGroupId(b)
    || (a.region_type === 'city' ? 1 : 0) - (b.region_type === 'city' ? 1 : 0)
    || Number(a.region_sort ?? 0) - Number(b.region_sort ?? 0)
    || String(a.region_name).localeCompare(String(b.region_name), 'fa')
    || Number(a.region_id) - Number(b.region_id)
    || (USER_ROLE_RANK[a.role] ?? 9) - (USER_ROLE_RANK[b.role] ?? 9)
    || Number(a.domain_sort ?? 0) - Number(b.domain_sort ?? 0)
    || String(a.username).localeCompare(String(b.username));
}

export function groupUsersForTree(sortedUsers) {
  const groups = [];
  for (const user of sortedUsers) {
    const last = groups[groups.length - 1];
    if (last && userGroupId(last[0]) === userGroupId(user)) last.push(user);
    else groups.push([user]);
  }
  return groups;
}
