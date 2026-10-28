const ROLE = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  COUNTRY_ADMIN: 'country_admin',
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
  if (user.role === ROLE.COUNTRY_ADMIN) {
    // Central-organization PR: the whole country and the provinces, never individual cities.
    return target.type === 'province' ||
      (target.type === 'country' && Number(target.id) === Number(user.region_id));
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

function policyOptions(optionsOrRegions) {
  if (Array.isArray(optionsOrRegions) || optionsOrRegions instanceof Map) {
    return { regions: optionsOrRegions, peerEditEnabled: false };
  }
  return { regions: optionsOrRegions?.regions, peerEditEnabled: Boolean(optionsOrRegions?.peerEditEnabled) };
}

// A user sees (and may edit) only their own news and the news of users *below* them:
//   country_admin -> province admins; province_admin -> city admins of their province.
// News of peers (same level) and of superiors is invisible, even read-only (the automatic portal feed is the one exception: the main admin and the central PR share it). The single exception is
// the owner-controlled `peer_edit_enabled` setting, which lets several admins of the *same unit*
// share that unit's news.
export function canViewNews(user, news, optionsOrRegions) {
  if (!user || !news) return false;
  if (user.role === ROLE.SUPER_ADMIN) return true;
  const { regions, peerEditEnabled } = policyOptions(optionsOrRegions);
  if (!regions) return false;
  if (Number(news.created_by) === Number(user.id)) return true;
  // The automatic portal feed is shared with the central organisation's PR (read-only; see canDeleteNews).
  if (news.source_url && user.role === ROLE.COUNTRY_ADMIN) return true;

  const creatorRegionId = news.created_by_region_id ?? news.creator_region_id;
  const creatorRole = news.created_by_role ?? news.creator_role;
  if (user.role === ROLE.COUNTRY_ADMIN) {
    if (creatorRole === ROLE.PROVINCE_ADMIN) return true;
    return peerEditEnabled && creatorRole === ROLE.COUNTRY_ADMIN &&
      Number(creatorRegionId) === Number(user.region_id);
  }
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

// Visible and editable are the same set: nobody gets a read-only window into a peer's or a superior's news.
export function canEditNews(user, news, { regions, peerEditEnabled = false } = {}) {
  if (!user || !news || !regions) return false;
  if (user.role === ROLE.SUPER_ADMIN) return true;
  if (news.source_url) return false;
  return canViewNews(user, news, { regions, peerEditEnabled });
}

export function canDeleteNews(user, news, options) {
  // Like the main admin, the central PR may remove items of the automatic portal feed (they cannot be edited).
  if (user?.role === ROLE.COUNTRY_ADMIN && news?.source_url) return canViewNews(user, news, options);
  return canEditNews(user, news, options);
}

// SQL twin of canViewNews for list/stat queries. Expects the news table aliased as `n` and the
// creator joined as `creator`. Returns null when the user may see everything.
export function newsVisibilitySql(user, regions, { peerEditEnabled = false } = {}) {
  if (!user) return { sql: '1 = 0', values: [] };
  if (user.role === ROLE.SUPER_ADMIN) return null;
  const parts = ['n.created_by = ?'];
  const values = [Number(user.id)];
  if (user.role === ROLE.COUNTRY_ADMIN) {
    parts.push(`creator.role = 'province_admin'`);
    parts.push('n.source_url IS NOT NULL');
    if (peerEditEnabled) {
      parts.push(`(creator.role = 'country_admin' AND creator.region_id = ?)`);
      values.push(Number(user.region_id));
    }
  } else if (user.role === ROLE.PROVINCE_ADMIN) {
    const cityIds = [...toRegionMap(regions).values()]
      .filter((region) => region.type === 'city' && Number(region.parent_id) === Number(user.region_id))
      .map((region) => Number(region.id));
    if (cityIds.length) {
      parts.push(`(creator.role = 'city_admin' AND creator.region_id IN (${cityIds.map(() => '?').join(', ')}))`);
      values.push(...cityIds);
    }
    if (peerEditEnabled) {
      parts.push(`(creator.role = 'province_admin' AND creator.region_id = ?)`);
      values.push(Number(user.region_id));
    }
  } else if (user.role === ROLE.CITY_ADMIN && peerEditEnabled) {
    parts.push(`(creator.role = 'city_admin' AND creator.is_active = 1 AND creator.region_id = ?)`);
    values.push(Number(user.region_id));
  }
  return { sql: `(${parts.join(' OR ')})`, values };
}

// Regions whose users' activity a non-super admin may see in the audit log: their own unit and the units below it.
export function auditRegionIds(user, regions) {
  const map = toRegionMap(regions);
  const ids = new Set();
  if (!user) return ids;
  if (user.role === ROLE.SUPER_ADMIN) return new Set(map.keys());
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
