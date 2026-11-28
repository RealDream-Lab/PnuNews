import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = readFileSync(`${root}scripts/make-deploy-branch.sh`, 'utf8');

test('make-deploy-branch.sh accepts --yes / -y to answer the push question itself, and still asks otherwise', () => {
  assert.doesNotThrow(() => execFileSync('bash', ['-n', 'scripts/make-deploy-branch.sh'], { cwd: root }));
  assert.match(script, /--yes\|-y\) assume_yes=true ;;/);
  assert.match(script, /--prepare-only\) prepare_only=true ;;/);
  assert.match(script, /if \[\[ "\$assume_yes" == true \]\]; then\s+answer=y/);
  assert.match(script, /IFS= read -r answer/, 'without --yes the question is still asked');
  const help = execFileSync('bash', ['scripts/make-deploy-branch.sh', '--help'], { cwd: root, encoding: 'utf8' });
  assert.match(help, /\[--yes\]/);
});

test('an unknown option is refused before anything is done', () => {
  assert.throws(() => execFileSync('bash', ['scripts/make-deploy-branch.sh', '--nope'], { cwd: root, stdio: 'pipe' }), (error) => error.status === 2);
});
