import { readdir, readFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';

export async function migrate(pool, migrationsDir = new URL('../migrations/', import.meta.url)) {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET time_zone = '+00:00'");
    const [lockRows] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', ['pnunews:migrations']);
    if (Number(lockRows[0].acquired) !== 1) {
      throw new Error('قفل مهاجرت پایگاه داده دریافت نشد.\nCould not acquire the migration lock.');
    }
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    const [appliedRows] = await connection.query('SELECT version FROM schema_migrations');
    const applied = new Set(appliedRows.map((row) => row.version));
    const names = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql') && !name.startsWith('.')).sort();

    for (const name of names) {
      if (applied.has(name)) continue;
      const sql = await readFile(new URL(name, migrationsDir), 'utf8');
      await connection.beginTransaction();
      try {
        for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
          await connection.query(statement);
        }
        await connection.query('INSERT INTO schema_migrations (version) VALUES (?)', [name]);
        await connection.commit();
        console.info(`Migration applied: ${name}`);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }
  } finally {
    try {
      await connection.query("SELECT RELEASE_LOCK(?)", ['pnunews:migrations']);
    } finally {
      connection.release();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const pool = createPool(config.db);
  try {
    await migrate(pool);
    console.info('Migrations complete.');
  } catch (error) {
    console.error(`اجرای مهاجرت پایگاه داده ناموفق بود.\nDatabase migration failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
