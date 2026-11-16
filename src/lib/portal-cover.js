// Keeps the cover of a portal news on our own server: the picture is downloaded from pnu.ac.ir once, converted to the same
// 400/800/1280 px WebP set as an uploaded cover (src/lib/images.js) and stored as the news' cover attachment, so the feed
// never depends on the portal (or on its files staying there). Used by the importer for every new news
// (src/portal-news.js) and by scripts/localize-portal-covers.js for the news imported before.
import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { portalUrl } from '../portal-parse.js';
import { detectImageMime, processImage as defaultProcessImage } from './images.js';

const USER_AGENT = 'Mozilla/5.0 (compatible; PNU-News-Reader/1.0)';
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TRIES = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `gone` = the portal answered 404/410: the picture no longer exists there, so retrying is pointless.
export class CoverDownloadError extends Error {
  constructor(message, { status = null, gone = false } = {}) {
    super(message);
    this.name = 'CoverDownloadError';
    this.status = status;
    this.gone = gone;
  }
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new CoverDownloadError('حجم عکس بیش از حد مجاز است.');
  const reader = response.body?.getReader();
  if (!reader) throw new CoverDownloadError('پاسخ پورتال بدنه ندارد.');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new CoverDownloadError('حجم عکس بیش از حد مجاز است.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// Only https://*.pnu.ac.ir addresses are fetched, and every redirect hop must stay on them too.
export async function downloadPortalImage(address, { fetchImpl = fetch, timeoutMs = 20_000, maxBytes = MAX_BYTES, retryDelayMs = 1_000 } = {}) {
  let target = portalUrl(address);
  if (!target) throw new CoverDownloadError('نشانی عکس مجاز نیست (فقط https روی pnu.ac.ir).');
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response = null;
    let lastError = null;
    for (let attempt = 1; attempt <= TRIES && !response; attempt += 1) {
      try {
        response = await fetchImpl(target, {
          headers: { 'user-agent': USER_AGENT, accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = error;
        if (attempt < TRIES) await sleep(retryDelayMs * attempt);
      }
    }
    if (!response) throw new CoverDownloadError(`اتصال به پورتال برقرار نشد (${lastError?.cause?.code || lastError?.name || 'نامشخص'}).`);
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
      const next = portalUrl(new URL(response.headers.get('location'), target).href);
      if (!next) throw new CoverDownloadError('پورتال عکس را به نشانی نامعتبری هدایت کرد.');
      target = next;
      continue;
    }
    if (!response.ok) {
      throw new CoverDownloadError(`کد HTTP نامعتبر از پورتال: ${response.status}`, { status: response.status, gone: response.status === 404 || response.status === 410 });
    }
    return readLimited(response, maxBytes);
  }
  throw new CoverDownloadError('تعداد تغییر مسیرهای پورتال بیش از حد است.');
}

// Downloads the picture and makes the WebP set. Returns processImage's result (storedName, width, height, dominantColor, variants…).
export async function localizeCover({ url, uploadRoot, now = new Date(), fetchImpl = fetch, processImage = defaultProcessImage, retryDelayMs = 1_000 }) {
  const bytes = await downloadPortalImage(url, { fetchImpl, retryDelayMs });
  if (!detectImageMime(bytes.subarray(0, 16))) throw new CoverDownloadError('پاسخ پورتال تصویر معتبر نیست.');
  const temporary = path.join(os.tmpdir(), `pnu-portal-cover-${randomBytes(8).toString('hex')}`);
  await writeFile(temporary, bytes);
  try {
    return await processImage(temporary, uploadRoot, { kind: 'cover', now });
  } finally {
    await rm(temporary, { force: true });
  }
}

export function coverOriginalName(url) {
  try {
    return decodeURIComponent(path.basename(new URL(url).pathname)).slice(0, 255) || 'cover';
  } catch {
    return 'cover';
  }
}

// Stores the processed picture as the news' cover. `updated_at = updated_at` keeps the news' modification time as it was.
export async function attachCover(connection, newsId, image, sourceUrl) {
  const [result] = await connection.execute(
    `INSERT INTO attachments (news_id, kind, original_name, stored_name, mime, size_bytes, width, height, dominant_color)
     VALUES (?, 'cover', ?, ?, ?, ?, ?, ?, ?)`,
    [newsId, coverOriginalName(sourceUrl), image.storedName, image.mime, image.sizeBytes, image.width, image.height, image.dominantColor],
  );
  const attachmentId = Number(result.insertId);
  await connection.execute('UPDATE news SET cover_attachment_id = ?, updated_at = updated_at WHERE id = ?', [attachmentId, newsId]);
  return attachmentId;
}

// For a failed or rolled-back save: the files must not stay behind without a database row.
export async function removeCoverFiles(image) {
  await Promise.all((image?.variants ?? []).map((variant) => rm(variant.path, { force: true })));
}
