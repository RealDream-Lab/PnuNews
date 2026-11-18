// Builds the compact city list used by the prayer-times card (nearest city to the visitor's position):
//   data/IranCities.json  ->  public/shared/iran-cities.v1.json   as  { v: 1, cities: [[name, province, lat, lon], ...] }
// Letters are normalised to Persian forms (ي→ی, ك→ک) and coordinates rounded to 4 decimals (about 10 m).
// Run after changing data/IranCities.json:  node scripts/build-iran-cities.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fa = (value) => String(value).replaceAll('ي', 'ی').replaceAll('ك', 'ک').replace(/\s+/g, ' ').trim();

export function compactCities(source) {
  const seen = new Set();
  const cities = [];
  for (const entry of source) {
    const lat = Number.parseFloat(entry.latitude);
    const lon = Number.parseFloat(entry.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 24 || lat > 41 || lon < 43 || lon > 64) continue; // Iran's bounding box
    const row = [fa(entry.city), fa(entry.province), Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4];
    const key = row.join('|');
    if (!row[0] || seen.has(key)) continue;
    seen.add(key);
    cities.push(row);
  }
  return { v: 1, cities };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = JSON.parse(await readFile(path.join(root, 'data/IranCities.json'), 'utf8'));
  const output = compactCities(source);
  await writeFile(path.join(root, 'public/shared/iran-cities.v1.json'), `${JSON.stringify(output)}\n`);
  console.log(`${output.cities.length} cities of ${source.length} written to public/shared/iran-cities.v1.json`);
}
