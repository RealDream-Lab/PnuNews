import { hashToken } from '../auth/sessions.js';

// A signed-in dashboard user is also a reader of the news page: the page asks /api/reader/me, and when there is no reader session
// but the dashboard session cookie is valid, the answer is the reader account linked to that user (reader_users.staff_user_id).
// No second login, no reader session row and no reader cookie: the identity follows the dashboard session, so signing out of the
// dashboard, deactivating the user or deleting it ends it at once. The account has no phone number; its card shows the post.

const ROLE_LABELS = Object.freeze({
  super_admin: 'مدیر ارشد',
  country_admin: 'روابط عمومی سازمان مرکزی',
  province_admin: 'مدیر استان',
  city_admin: 'مدیر مرکز دانشگاهی',
});

export const staffRoleLabel = (role, domainName = null) => (role === 'domain_user' ? (domainName ? `کاربر حوزه ${domainName}` : 'کاربر حوزه') : (ROLE_LABELS[role] ?? 'مدیر'));

// Where the user works: a city with its province, a province, or the central organisation.
export function staffPlace({ level, region_name: region, parent_name: parent }) {
  if (level === 'city') return parent ? `${region}، ${parent}` : region;
  if (level === 'province') return `استان ${region}`;
  return 'سازمان مرکزی';
}

// «Ali Rezaei Moghadam»: the first word is the first name, the rest the last name (both columns must not be NULL).
export function splitFullName(fullName) {
  const words = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  return { first: (words[0] ?? 'مدیر').slice(0, 80), last: words.slice(1).join(' ').slice(0, 80) };
}

export const staffView = (row) => ({
  role_label: staffRoleLabel(row.role, row.domain_name),
  domain: row.domain_name ?? null,
  place: staffPlace(row),
});

// The reader account of the dashboard session in the request (or null): found, created on first use, and kept in step with the
// user's name and unit.
export async function staffReaderFromRequest(pool, token) {
  const [rows] = await pool.execute(
    `SELECT u.id AS staff_id, u.full_name, u.role, u.region_id, d.name AS domain_name, r.type AS level, r.name AS region_name, p.name AS parent_name
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN regions r ON r.id = u.region_id
     LEFT JOIN regions p ON p.id = r.parent_id LEFT JOIN work_domains d ON d.id = u.domain_id
     WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() AND u.is_active = 1 LIMIT 1`,
    [hashToken(token)],
  );
  const staff = rows[0];
  if (!staff) return null;
  const { first, last } = splitFullName(staff.full_name);
  const find = async () => (await pool.execute(
    'SELECT id, phone, first_name, last_name, is_student, student_no, unit_id FROM reader_users WHERE staff_user_id = ? LIMIT 1',
    [staff.staff_id],
  ))[0][0];
  let reader = await find();
  if (!reader) {
    // Two requests at once may both get here: the unique key lets one win and the other reads its row.
    await pool.execute(
      'INSERT IGNORE INTO reader_users (phone, first_name, last_name, is_student, student_no, unit_id, staff_user_id) VALUES (NULL, ?, ?, 0, NULL, ?, ?)',
      [first, last, staff.region_id, staff.staff_id],
    );
    reader = await find();
  } else if (reader.first_name !== first || reader.last_name !== last || Number(reader.unit_id) !== Number(staff.region_id)) {
    await pool.execute('UPDATE reader_users SET first_name = ?, last_name = ?, unit_id = ? WHERE id = ?', [first, last, staff.region_id, reader.id]);
    reader = { ...reader, first_name: first, last_name: last, unit_id: staff.region_id };
  }
  return reader ? { row: reader, staff: staffView(staff) } : null;
}
