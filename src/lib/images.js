import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const MAX_PIXELS = 40_000_000;
const VARIANT_WIDTHS = [400, 800, 1280];
let activeJobs = 0;
const waitingJobs = [];

async function withImageSlot(task) {
  if (activeJobs >= 2) await new Promise((resolve) => waitingJobs.push(resolve));
  activeJobs += 1;
  try {
    return await task();
  } finally {
    activeJobs -= 1;
    waitingJobs.shift()?.();
  }
}

function colorHex({ r, g, b }) {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

function dateSegments(now) {
  const date = now instanceof Date ? now : new Date(now);
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, '0'),
  };
}

export function detectImageMime(header) {
  if (!Buffer.isBuffer(header)) header = Buffer.from(header);
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (header.length >= 12 && header.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1|heif)$/.test(header.toString('ascii', 8, 12))) return 'image/heic';
  return null;
}

export async function processImage(inputPath, uploadRoot, { kind = 'image', now = new Date() } = {}) {
  return withImageSlot(async () => {
    const source = sharp(inputPath, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
    const metadata = await source.metadata();
    if (!['jpeg', 'png', 'webp', 'heif'].includes(metadata.format) || !metadata.width || !metadata.height) {
      throw new Error('فرمت تصویر پشتیبانی نمی‌شود.');
    }
    if (metadata.width * metadata.height > MAX_PIXELS) throw new Error('ابعاد تصویر از حد مجاز بیشتر است.');
    if (metadata.format === 'heif' && !sharp.format.heif.input.file) {
      throw new Error('پردازش HEIC در این محیط پشتیبانی نمی‌شود.');
    }
    const stats = await sharp(inputPath, { limitInputPixels: MAX_PIXELS }).stats();
    const dominantColor = colorHex(stats.dominant);
    const { year, month } = dateSegments(now);
    const directory = path.join(uploadRoot, 'img', year, month);
    const baseName = randomBytes(16).toString('hex');
    await mkdir(directory, { recursive: true });
    const variants = [];

    try {
      for (const width of VARIANT_WIDTHS) {
        const fileName = `${baseName}-${width}.webp`;
        const outputPath = path.join(directory, fileName);
        const pipeline = sharp(inputPath, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate();
        if (kind === 'cover') {
          pipeline.resize(width, Math.round(width * 9 / 16), { fit: 'cover', position: 'centre' });
        } else {
          pipeline.resize({ width, fit: 'inside' });
        }
        const info = await pipeline.webp({ quality: 75, effort: 4 }).toFile(outputPath);
        variants.push({
          width: info.width,
          height: info.height,
          sizeBytes: info.size,
          fileName,
          path: outputPath,
        });
      }
    } catch (error) {
      await Promise.all(variants.map((variant) => rm(variant.path, { force: true })));
      throw error;
    }

    const largest = variants.at(-1);
    return {
      storedName: `img/${year}/${month}/${baseName}`,
      mime: 'image/webp',
      sizeBytes: variants.reduce((sum, variant) => sum + variant.sizeBytes, 0),
      width: largest.width,
      height: largest.height,
      dominantColor,
      variants,
    };
  });
}
