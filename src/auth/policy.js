const ROLE = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  COUNTRY_ADMIN: 'country_admin',
  PROVINCE_ADMIN: 'province_admin',
  CITY_ADMIN: 'city_admin',
  // A user of one work domain (education, exams, tuition, …) inside a single unit. Publishes news of that
  // domain only; the unit's admin supervises it. Which level it works at follows from its region.
  DOMAIN_USER: 'domain_user',
});

const UNIT_ADMIN_ROLES = Object.freeze([ROLE.COUNTRY_ADMIN, ROLE.PROVINCE_ADMIN, ROLE.CITY_ADMIN]);
const ROLE_BY_LEVEL = Object.freeze({
  country: ROLE.COUNTRY_ADMIN,
  province: ROLE.PROVINCE_ADMIN,
  city: ROLE.CITY_ADMIN,
});
const LEVEL_BY_ROLE = Object.freeze({
  [ROLE.COUNTRY_ADMIN]: 'country',
  [ROLE.PROVINCE_ADMIN]: 'province',
  [ROLE.CITY_ADMIN]: 'city',
});

export function isUnitAdmin(user) {
  return UNIT_ADMIN_ROLES.includes(user?.role);
}

function toRegionMap(regions) {
  if (regions instanceof Map) return regions;
  return new Map((regions ?? []).map((region) => [Number(region.id), region]));
}

function regionById(regions, id) {
  return toRegionMap(regions).get(Number(id)) ?? null;
}

export function provinceForRegion(regionId, regions) {
  const map = toRegionMap(regions);
  const region = map.get(Number(regionId));
  if (!region) return null;
  if (region.type === 'province') return region;
  if (region.type !== 'city') return null;
  const parent = map.get(Number(region.parent_id));
  return parent?.type === 'province' ? parent : null;
}

// The role whose publishing rights a user has: a domain user publishes exactly where the admin of
// the same level does (country -> everywhere, province -> the province and its cities, city -> the city).
function publishingRole(user, regions) {
  if (user.role !== ROLE.DOMAIN_USER) return user.role;
  return ROLE_BY_LEVEL[regionById(regions, user.region_id)?.type] ?? null;
}

export function canPublishTo(user, targetRegion, regions) {
  if (!user || !targetRegion) return false;
  const target = typeof targetRegion === 'object'
    ? targetRegion
    : regionById(regions, targetRegion);
  if (!target) return false;
  const role = publishingRole(user, regions);

  if (role === ROLE.SUPER_ADMIN) {
    return ['country', 'province', 'city'].includes(target.type);
  }
  if (role === ROLE.COUNTRY_ADMIN) {
    // Central-organization PR publishes exactly where the main admin does: the country, any province, any city.
    return ['country', 'province', 'city'].includes(target.type);
  }
  if (role === ROLE.PROVINCE_ADMIN) {
    const ownProvince = regionById(regions, user.region_id);
    return ownProvince?.type === 'province' && (
      (target.type === 'province' && Number(target.id) === Number(ownProvince.id)) ||
      (target.type === 'city' && Number(target.parent_id) === Number(ownProvince.id))
    );
  }
  if (role === ROLE.CITY_ADMIN) {
    return target.type === 'city' && Number(target.id) === Number(user.region_id);
  }
  return false;
}

function policyRegions(optionsOrRegions) {
  if (Array.isArray(optionsOrRegions) || optionsOrRegions instanceof Map) return optionsOrRegions;
  return optionsOrRegions?.regions;
}

// A user sees (and may edit) only their own news plus:
//   - the news of the domain users of their *own* unit (every unit admin supervises their domain users);
//   - the news of the admins *below* them: country_admin -> province admins; province_admin -> city admins of their province.
// A domain user sees nothing but their own news. Peers, superiors and the domain users of other units
// (including units below) are invisible, even read-only. The automatic portal feed is the one exception:
// the main admin and the central PR share it.
export function canViewNews(user, news, optionsOrRegions) {
  if (!user || !news) return false;
  if (user.role === ROLE.SUPER_ADMIN) return true;
  const regions = policyRegions(optionsOrRegions);
  if (!regions) return false;
  if (Number(news.created_by) === Number(user.id)) return true;
  // The automatic portal feed is shared with the central organisation's PR (read-only; see canDeleteNews).
  if (news.source_url && user.role === ROLE.COUNTRY_ADMIN) return true;
  if (!isUnitAdmin(user)) return false;

  const creatorRegionId = news.created_by_region_id ?? news.creator_region_id;
  const creatorRole = news.created_by_role ?? news.creator_role;
  if (creatorRole === ROLE.DOMAIN_USER) return Number(creatorRegionId) === Number(user.region_id);
  if (user.role === ROLE.COUNTRY_ADMIN) return creatorRole === ROLE.PROVINCE_ADMIN;
  if (user.role === ROLE.PROVINCE_ADMIN) {
    return creatorRole === ROLE.CITY_ADMIN &&
      Number(provinceForRegion(creatorRegionId, regions)?.id) === Number(user.region_id);
  }
  return false;
}

// Visible and editable are the same set: nobody gets a read-only window into a peer's or a superior's news.
export function canEditNews(user, news, { regions } = {}) {
  if (!user || !news || !regions) return false;
  if (user.role === ROLE.SUPER_ADMIN) return true;
  if (news.source_url) return false;
  return canViewNews(user, news, { regions });
}

export function canDeleteNews(user, news, options) {
  // Like the main admin, the central PR may remove items of the automatic portal feed (they cannot be edited).
  if (user?.role === ROLE.COUNTRY_ADMIN && news?.source_url) return canViewNews(user, news, options);
  return canEditNews(user, news, options);
}

// SQL twin of canViewNews for list/stat queries. Expects the news table aliased as `n` and the
// creator joined as `creator`. Returns null when the user may see everything.
export function newsVisibilitySql(user, regions) {
  if (!user) return { sql: '1 = 0', values: [] };
  if (user.role === ROLE.SUPER_ADMIN) return null;
  const parts = ['n.created_by = ?'];
  const values = [Number(user.id)];
  if (user.role === ROLE.COUNTRY_ADMIN) {
    parts.push(`creator.role = 'province_admin'`);
    parts.push('n.source_url IS NOT NULL');
  } else if (user.role === ROLE.PROVINCE_ADMIN) {
    const cityIds = [...toRegionMap(regions).values()]
      .filter((region) => region.type === 'city' && Number(region.parent_id) === Number(user.region_id))
      .map((region) => Number(region.id));
    if (cityIds.length) {
      parts.push(`(creator.role = 'city_admin' AND creator.region_id IN (${cityIds.map(() => '?').join(', ')}))`);
      values.push(...cityIds);
    }
  }
  if (isUnitAdmin(user)) {
    parts.push(`(creator.role = 'domain_user' AND creator.region_id = ?)`);
    values.push(Number(user.region_id));
  }
  return { sql: `(${parts.join(' OR ')})`, values };
}

// Regions whose users' activity a non-super admin may see in the audit log: their own unit and the units below it.
// Domain users have no access to the log.
export function auditRegionIds(user, regions) {
  const map = toRegionMap(regions);
  const ids = new Set();
  if (!user) return ids;
  if (user.role === ROLE.SUPER_ADMIN) return new Set(map.keys());
  if (!isUnitAdmin(user)) return ids;
  for (const region of map.values()) {
    const own = Number(region.id) === Number(user.region_id);
    const below = user.role === ROLE.COUNTRY_ADMIN
      ? region.type === 'province'
      : user.role === ROLE.PROVINCE_ADMIN && region.type === 'city' && Number(region.parent_id) === Number(user.region_id);
    if (own || below) ids.add(Number(region.id));
  }
  return ids;
}

export function canCreateUser(actor, role, region, regions) {
  if (!actor || !region) return false;
  const target = typeof region === 'object' ? region : regionById(regions, region);
  if (!target) return false;
  if (role === ROLE.DOMAIN_USER) {
    // Every unit admin creates the domain users of their own unit; the main admin may do so anywhere.
    if (actor.role === ROLE.SUPER_ADMIN) return ['country', 'province', 'city'].includes(target.type);
    return isUnitAdmin(actor) && target.type === LEVEL_BY_ROLE[actor.role] && Number(target.id) === Number(actor.region_id);
  }
  if (actor.role === ROLE.SUPER_ADMIN) {
    return (role === ROLE.COUNTRY_ADMIN && target.type === 'country') ||
      (role === ROLE.PROVINCE_ADMIN && target.type === 'province') ||
      (role === ROLE.CITY_ADMIN && target.type === 'city');
  }
  if (actor.role === ROLE.COUNTRY_ADMIN) {
    return role === ROLE.PROVINCE_ADMIN && target.type === 'province';
  }
  if (actor.role === ROLE.PROVINCE_ADMIN) {
    return role === ROLE.CITY_ADMIN && target.type === 'city' &&
      Number(target.parent_id) === Number(actor.region_id);
  }
  return false;
}

const MANAGE_ACTIONS = new Set(['view', 'patch', 'deactivate', 'activate', 'reset_password', 'reset_2fa', 'delete']);

export function canManageUser(actor, targetUser, action, regions) {
  if (!actor || !targetUser || actor.id == null || targetUser.id == null || Number(actor.id) === Number(targetUser.id)) return false;
  if (!MANAGE_ACTIONS.has(action)) return false;
  if (action === 'delete' && targetUser.role === ROLE.SUPER_ADMIN) return false;
  if (actor.role === ROLE.SUPER_ADMIN) return true;
  if (targetUser.role === ROLE.DOMAIN_USER) {
    return isUnitAdmin(actor) && Number(actor.region_id) === Number(targetUser.region_id);
  }
  if (actor.role === ROLE.COUNTRY_ADMIN) {
    if (targetUser.role !== ROLE.PROVINCE_ADMIN) return false;
    return regionById(regions, targetUser.region_id)?.type === 'province';
  }
  if (actor.role !== ROLE.PROVINCE_ADMIN || targetUser.role !== ROLE.CITY_ADMIN) return false;
  const targetRegion = regionById(regions, targetUser.region_id);
  return targetRegion?.type === 'city' && Number(targetRegion.parent_id) === Number(actor.region_id);
}

export function canManageRegion(user) {
  return user?.role === ROLE.SUPER_ADMIN;
}

export function allowedPublishTargets(user, regions) {
  return [...toRegionMap(regions).values()]
    .filter((region) => canPublishTo(user, region, regions))
    .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) || Number(a.id) - Number(b.id));
}
