// Usage: npm run bump -- 0.1.2
// Moves the whole app to a new version in one step: package.json / package-lock.json, the versioned
// asset names in public/ (e.g. app.v0.1.1.js), every reference to them, and the service worker cache name.
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const next = process.argv[2];
const semver = /^\d+\.\d+\.\d+$/;
if (!semver.test(next ?? '')) {
  console.error('Usage: npm run bump -- <major.minor.patch>   e.g. npm run bump -- 0.1.2');
  process.exit(1);
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const current = packageJson.version;
if (current === next) {
  console.error(`Already at ${current}.`);
  process.exit(1);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

// "0.1.1" as it appears in plain text and inside regex literals / escaped strings (0\.1\.1, 0\\.1\\.1).
const forms = (version) => [version, version.replaceAll('.', '\\.'), version.replaceAll('.', '\\\\.')];
const pairs = forms(current).map((from, index) => [from, forms(next)[index]]);
const pattern = (from) => new RegExp(`(\\.v|shell-v|v)${from.replaceAll('\\', '\\\\').replaceAll('.', '\\.')}(?!\\d)`, 'g');

let renamed = 0;
let edited = 0;
for (const file of await walk(path.join(root, 'public'))) {
  const base = path.basename(file);
  if (new RegExp(`\\.v${current.replaceAll('.', '\\.')}\\.`).test(base)) {
    await rename(file, path.join(path.dirname(file), base.replace(`.v${current}.`, `.v${next}.`)));
    renamed += 1;
  }
}

const textFile = /\.(js|html|css|webmanifest|json)$/;
for (const directory of ['public', 'src']) {
  for (const file of await walk(path.join(root, directory))) {
    if (!textFile.test(file)) continue;
    const original = await readFile(file, 'utf8');
    let updated = original;
    for (const [from, to] of pairs) updated = updated.replace(pattern(from), (match, prefix) => `${prefix}${to}`);
    if (updated !== original) {
      await writeFile(file, updated);
      edited += 1;
    }
  }
}

packageJson.version = next;
await writeFile(path.join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
const lockPath = path.join(root, 'package-lock.json');
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
lock.version = next;
if (lock.packages?.['']) lock.packages[''].version = next;
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

console.log(`Version ${current} -> ${next}: renamed ${renamed} asset files, updated ${edited} files.`);
console.log('Next: commit, push, scripts/make-deploy-branch.sh');
