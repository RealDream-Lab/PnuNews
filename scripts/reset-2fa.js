import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';


const username = process.argv[2]?.trim();
if (!username) {
  console.error('کاربرد: node scripts/reset-2fa.js <username>');
  process.exit(1);
}

const config = loadConfig();
const pool = createPool(config.db);
try {
  const [users] = await pool.execute(
    'SELECT id, role FROM users WHERE username = ? AND is_active = 1 LIMIT 1',
    [username],
  );
  if (!users.length || users[0].role !== 'super_admin') {
    throw new Error('مدیر ارشد فعال با این نام کاربری پیدا نشد.');
  }
  const user = users[0];
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, totp_last_step = NULL
       WHERE id = ?`,
      [user.id],
    );
    await connection.execute('DELETE FROM backup_codes WHERE user_id = ?', [user.id]);
    await connection.execute('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    await connection.execute('DELETE FROM trusted_devices WHERE user_id = ?', [user.id]);
    await connection.execute(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, meta)
       VALUES (NULL, 'auth.totp_reset_cli', 'user', ?, JSON_OBJECT('target_user_id', ?))`,
      [user.id, user.id],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  console.info('احراز هویت دومرحله‌ای بازنشانی شد؛ کاربر باید در ورود بعدی دوباره ثبت‌نام کند.');
} catch (error) {
  console.error(`بازنشانی دومرحله‌ای ناموفق بود.\n2FA reset failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
