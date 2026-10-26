import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../scripts/migrate.js';
import { seed } from '../scripts/seed.js';

const config = loadConfig();

test('region data and database seeding are normalized and idempotent', async () => {
  const data = JSON.parse(await readFile(new URL('../data/regions.json', import.meta.url), 'utf8'));
  assert.equal(data.provinces.length, 31);
  assert.equal(data.provinces.reduce((sum, province) => sum + province.counties.length, 0), 448);

  for (const province of data.provinces) {
    assert.equal(province.name.trim(), province.name);
    assert.doesNotMatch(province.name, /[يىك\u200c]/);
    assert.equal(new Set(province.counties.map((county) => county.code)).size, province.counties.length);
    assert.equal(new Set(province.counties.map((county) => county.name)).size, province.counties.length);
  }

  const pool = createPool(config.db);
  try {
    await migrate(pool);
    await seed(pool);
    const [[before]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM regions) AS regions_count,
        (SELECT COUNT(*) FROM regions WHERE type = 'province') AS provinces_count,
        (SELECT COUNT(*) FROM regions WHERE type = 'city') AS cities_count
    `);
    assert.equal(Number(before.regions_count), 480);
    assert.equal(Number(before.provinces_count), 31);
    assert.equal(Number(before.cities_count), 448);

    await migrate(pool);
    await seed(pool);
    const [[after]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM regions) AS regions_count,
        (SELECT COUNT(*) FROM regions WHERE type = 'province') AS provinces_count,
        (SELECT COUNT(*) FROM regions WHERE type = 'city') AS cities_count
    `);
    assert.deepEqual(after, before);
    const [settings] = await pool.query('SELECT k FROM settings');
    for (const key of ['radio_enabled', 'radio_title', 'radio_stream_url', 'radio_nowplaying_url', 'site_title', 'max_city_admins', 'peer_edit_enabled']) {
      assert.ok(settings.some((setting) => setting.k === key), `missing setting ${key}`);
    }
  } finally {
    await pool.end();
  }
});
