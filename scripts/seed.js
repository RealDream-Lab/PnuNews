import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';

const categories = [
  'آموزشی',
  'امتحانات',
  'ثبت‌نام و پذیرش',
  'فرهنگی و دانشجویی',
  'پژوهشی',
  'اطلاعیه‌های عمومی',
];

const defaultSettings = {
  radio_enabled: '0',
  radio_title: '',
  radio_stream_url: '',
  radio_nowplaying_url: '',
  byline_show_person: '1',
  site_title: 'اخبار پیام نور',
  max_city_admins: '1',
  peer_edit_enabled: '0',
};

export async function seed(pool, regionsPath = new URL('../data/regions.json', import.meta.url)) {
  const source = JSON.parse(await readFile(regionsPath, 'utf8'));
  if (!Array.isArray(source.provinces) || source.provinces.length !== 31) {
    throw new Error('فهرست استان‌ها معتبر نیست؛ باید دقیقاً ۳۱ استان داشته باشد.');
  }

  const connection = await pool.getConnection();
  try {
    await connection.query("SET time_zone = '+00:00'");
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO regions (parent_id, type, name, code, sort_order, visibility_override)
       VALUES (NULL, 'country', ?, 'IR', 0, 'auto')
       ON DUPLICATE KEY UPDATE name = VALUES(name), type = VALUES(type)`,
      ['جمهوری اسلامی ایران'],
    );
    const [rootRows] = await connection.execute('SELECT id FROM regions WHERE code = ?', ['IR']);
    const rootId = rootRows[0].id;

    for (const [provinceIndex, province] of source.provinces.entries()) {
      await connection.execute(
        `INSERT INTO regions (parent_id, type, name, code, sort_order, visibility_override)
         VALUES (?, 'province', ?, ?, ?, 'auto')
         ON DUPLICATE KEY UPDATE parent_id = VALUES(parent_id), name = VALUES(name), sort_order = VALUES(sort_order)`,
        [rootId, province.name, province.code, provinceIndex + 1],
      );
      const [provinceRows] = await connection.execute('SELECT id FROM regions WHERE code = ?', [province.code]);
      const provinceId = provinceRows[0].id;

      for (const [countyIndex, county] of province.counties.entries()) {
        await connection.execute(
          `INSERT INTO regions (parent_id, type, name, code, sort_order, visibility_override)
           VALUES (?, 'city', ?, ?, ?, 'auto')
           ON DUPLICATE KEY UPDATE parent_id = VALUES(parent_id), name = VALUES(name), sort_order = VALUES(sort_order)`,
          [provinceId, county.name, county.code, countyIndex + 1],
        );
      }
    }

    for (const [index, name] of categories.entries()) {
      await connection.execute(
        `INSERT INTO categories (name, sort_order, is_active) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order), is_active = 1`,
        [name, index + 1],
      );
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
      await connection.execute('INSERT IGNORE INTO settings (k, v) VALUES (?, ?)', [key, value]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const pool = createPool(config.db);
  try {
    await seed(pool);
    console.info('Region, category and setting seed complete.');
  } catch (error) {
    console.error(`اجرای داده‌های اولیه ناموفق بود.\nSeeding failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
