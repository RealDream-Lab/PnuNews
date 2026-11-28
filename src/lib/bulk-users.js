import { revokeStaffReaderSessions } from './staff-reader.js';

// Switch every dashboard user off or on in one go (main admin only; the route checks that). Never touched: main admins and the system
// account (the portal robot), and the person who asks. `findConflict(connection, target)` is the «one active admin per unit and one
// active user per work domain per unit» rule of admin.js. Runs inside the caller's transaction, which also holds the regions lock.
//
// Switching off ends every session of those users (dashboard and the linked reader account). Switching on tries users most-recent
// login first, so when a unit has several inactive admins the one who worked last is the one who comes back; a user that would
// break the rule is skipped and counted.
export async function bulkSetActive(connection, { actorId, wanted, findConflict }) {
  const [candidates] = await connection.execute(
    `SELECT id, role, region_id, domain_id FROM users
     WHERE is_active = ? AND is_system = 0 AND role <> 'super_admin' AND id <> ?
     ORDER BY (last_login_at IS NULL), last_login_at DESC, id DESC`,
    [wanted ? 0 : 1, actorId],
  );
  let changed = 0;
  let skipped = 0;
  for (const target of candidates) {
    if (wanted) {
      if (await findConflict(connection, target)) {
        skipped += 1;
        continue;
      }
      await connection.execute('UPDATE users SET is_active = 1 WHERE id = ?', [target.id]);
    } else {
      await connection.execute('UPDATE users SET is_active = 0 WHERE id = ?', [target.id]);
      await connection.execute('DELETE FROM sessions WHERE user_id = ?', [target.id]);
      await revokeStaffReaderSessions(connection, target.id);
    }
    changed += 1;
  }
  return { changed, skipped };
}
