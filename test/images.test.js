import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { processImage } from '../src/lib/images.js';

async function coverShapes(width, height) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pnu-img-'));
  try {
    const input = path.join(dir, 'in.png');
    await sharp({ create: { width, height, channels: 3, background: '#c33' } }).png().toFile(input);
    const result = await processImage(input, dir, { kind: 'cover' });
    return result.variants.map((variant) => ({ width: variant.width, height: variant.height }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a cover keeps the shape of the uploaded picture: portrait, 4:3 and 16:9 are not cropped', async () => {
  for (const [width, height] of [[1000, 2000], [1600, 1200], [1920, 1080], [3000, 900]]) {
    for (const variant of await coverShapes(width, height)) {
      assert.ok(Math.abs(variant.width / variant.height - width / height) < 0.02, `${width}x${height} -> ${variant.width}x${variant.height}`);
    }
  }
});

test('a cover is never enlarged beyond the uploaded picture, and a very tall one is limited to twice the width of its box', async () => {
  const small = await coverShapes(500, 300);
  assert.deepEqual(small.map((variant) => variant.width), [400, 500, 500]);
  // the variants are 400, 800 and 1280 px wide boxes; a very tall picture may be at most twice as tall as its box is wide
  const tall = await coverShapes(600, 4000);
  [400, 800, 1280].forEach((box, index) => assert.ok(tall[index].height <= box * 2, `${box}: ${tall[index].width}x${tall[index].height}`));
});
