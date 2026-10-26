import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const deployScript = await readFile(new URL('../scripts/make-deploy-branch.sh', import.meta.url), 'utf8');

test('deploy dependency check accepts versioned sharp Linux x64 binaries', async () => {
  const nameMatch = deployScript.match(/-name '([^']+)' -print -quit/);
  assert.ok(nameMatch, 'deploy script must find a versioned sharp native binary');

  const directory = await mkdtemp(join(tmpdir(), 'pnunews-sharp-check-'));
  try {
    const libDirectory = join(directory, 'node_modules', '@img', 'sharp-linux-x64', 'lib');
    await mkdir(libDirectory, { recursive: true });
    const binaryName = 'sharp-linux-x64-0.35.5.node';
    await writeFile(join(libDirectory, binaryName), 'fixture');

    const result = spawnSync('find', [libDirectory, '-maxdepth', '1', '-type', 'f', '-name', nameMatch[1], '-print', '-quit'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(basename(result.stdout.trim()), binaryName);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
