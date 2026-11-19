#!/usr/bin/env node
// Writes the build stamp that the "About" dialog shows: { builtAt: <UTC ISO, to the second>, version }.
// Called by scripts/make-deploy-branch.sh on the freshly checked-out worktree, so the moment is the moment the deploy
// branch was built. Usage: node scripts/stamp-build.js <output file> [--at <ISO moment>]   (--at is for tests)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [output, flag, given] = process.argv.slice(2);
if (!output) {
  console.error('Usage: node scripts/stamp-build.js <output file> [--at <ISO moment>]');
  process.exit(2);
}
const moment = flag === '--at' ? new Date(given) : new Date();
if (Number.isNaN(moment.getTime())) {
  console.error('Invalid --at moment.');
  process.exit(2);
}
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
writeFileSync(output, `${JSON.stringify({ builtAt: moment.toISOString().replace(/\.\d{3}Z$/, 'Z'), version })}\n`);
console.log(`Build stamp written: ${output}`);
