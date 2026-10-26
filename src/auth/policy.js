const ROLE = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  PROVINCE_ADMIN: 'province_admin',
  CITY_ADMIN: 'city_admin',
});

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

export function canPublishTo(user, targetRegion, regions) {
  if (!user || !targetRegion) return false;
  const target = typeof targetRegion === 'object'
    ? targetRegion
    : regionById(regions, targetRegion);
  if (!target) return false;

  if (user.role === ROLE.SUPER_ADMIN) {
    return ['country', 'province', 'city'].includes(target.type);
  }
  if (user.role === ROLE.PROVINCE_ADMIN) {
    const ownProvince = regionById(regions, user.region_id);
    return ownProvince?.type === 'province' && (
      (target.type === 'province' && Number(target.id) === Number(ownProvince.id)) ||
      (target.type === 'city' && Number(target.parent_id) === Number(ownProvince.id))
    );
  }
  if (user.role === ROLE.CITY_ADMIN) {
    return target.type === 'city' && Number(target.id) === Number(user.region_id);
  }
  return false;
}

export function adminRegionIds(user, regions) {
  const map = toRegionMap(regions);
  if (!user) return new Set();
  if (user.role === ROLE.SUPER_ADMIN) return new Set(map.keys());

  const province = provinceForRegion(user.region_id, map);
  const allowed = new Set();
  for (const region of map.values()) {
    if (region.type === 'country' || Number(region.id) === Number(province?.id) ||
      (region.type === 'city' && Number(region.parent_id) === Number(province?.id))) {
      allowed.add(Number(region.id));
    }
  }
  return allowed;
}

export function canViewNews(user, news, regions) {
  if (!user || !news) return false;
  if (user.role === ROLE.SUPER_ADMIN) return true;
  const source = regionById(regions, news.origin_region_id);
  if (!source) return false;
  if (source.type === 'country') return true;
  const province = provinceForRegion(user.region_id, regions);
  return Boolean(province && Number(province.id) === Number(provinceForRegion(source.id, regions)?.id));
}

export function canEditNews(user, news, { regions, peerEditEnabled = false } = {}) {
  if (!user || !news || !regions) return false;
  if (user.role === ROLE.SUPER_ADMIN) return true;
  if (!canViewNews(user, news, regions)) return false;
  if (Number(news.created_by) === Number(user.id)) return true;

  const creatorRegionId = news.created_by_region_id ?? news.creator_region_id;
  const creatorRole = news.created_by_role ?? news.creator_role;
  if (user.role === ROLE.PROVINCE_ADMIN) {
    if (creatorRole === ROLE.CITY_ADMIN) {
      return Number(provinceForRegion(creatorRegionId, regions)?.id) === Number(user.region_id);
    }
    return peerEditEnabled && creatorRole === ROLE.PROVINCE_ADMIN &&
      Number(creatorRegionId) === Number(user.region_id);
  }
  if (user.role === ROLE.CITY_ADMIN && peerEditEnabled) {
    const creatorIsActive = news.created_by_is_active === true || news.created_by_is_active === 1;
    return creatorRole === ROLE.CITY_ADMIN && creatorIsActive &&
      Number(creatorRegionId) === Number(user.region_id);
  }
  return false;
}

export function canDeleteNews(user, news, options) {
  return canEditNews(user, news, options);
}

export function canCreateUser(actor, role, region, regions) {
  if (!actor || !region) return false;
  const target = typeof region === 'object' ? region : regionById(regions, region);
  if (!target) return false;
  if (actor.role === ROLE.SUPER_ADMIN) {
    return (role === ROLE.PROVINCE_ADMIN && target.type === 'province') ||
      (role === ROLE.CITY_ADMIN && target.type === 'city');
  }
  if (actor.role === ROLE.PROVINCE_ADMIN) {
    return role === ROLE.CITY_ADMIN && target.type === 'city' &&
      Number(target.parent_id) === Number(actor.region_id);
  }
  return false;
}

const MANAGE_ACTIONS = new Set(['view', 'patch', 'deactivate', 'activate', 'reset_password', 'reset_2fa']);

export function canManageUser(actor, targetUser, action, regions) {
  if (!actor || !targetUser || actor.id == null || targetUser.id == null || Number(actor.id) === Number(targetUser.id)) return false;
  if (!MANAGE_ACTIONS.has(action)) return false;
  if (actor.role === ROLE.SUPER_ADMIN) return true;
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
