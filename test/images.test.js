import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { detectImageMime, processImage } from '../src/lib/images.js';

test('image pipeline rotates, creates three WebP cover sizes, and strips metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pnunews-image-'));
  try {
    const source = path.join(root, 'source.jpg');
    const image = await sharp({ create: { width: 100, height: 60, channels: 3, background: '#c83228' } })
      .jpeg()
      .withMetadata({ orientation: 6, exif: { IFD0: { Artist: 'private metadata' } } })
      .toBuffer();
    await writeFile(source, image);
    assert.equal(detectImageMime(image.subarray(0, 32)), 'image/jpeg');

    const result = await processImage(source, root, { kind: 'cover', now: new Date('2026-04-05T00:00:00Z') });
    assert.equal(result.mime, 'image/webp');
    assert.match(result.storedName, /^img\/2026\/04\/[a-f\d]{32}$/);
    assert.deepEqual(result.variants.map(({ width, height }) => [width, height]), [[400, 225], [800, 450], [1280, 720]]);
    assert.match(result.dominantColor, /^#[a-f\d]{6}$/i);
    for (const variant of result.variants) {
      const metadata = await sharp(variant.path).metadata();
      assert.equal(metadata.format, 'webp');
      assert.equal(metadata.exif, undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
