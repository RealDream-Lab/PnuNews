import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import Busboy from 'busboy';

export const MAX_IMAGE_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_FILE_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_REQUEST_UPLOAD_BYTES = 30 * 1024 * 1024;
const ALLOWED_FIELDS = new Set(['cover', 'image', 'file']);

function safeOriginalName(value) {
  const base = path.basename(String(value ?? '').replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255);
  return base || 'attachment';
}

export async function receiveMultipart(request, uploadRoot) {
  const temporaryDirectory = path.join(uploadRoot, '.tmp');
  await mkdir(temporaryDirectory, { recursive: true });

  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: { files: 18, fields: 8, fieldSize: 1024, fileSize: MAX_FILE_UPLOAD_BYTES },
      });
    } catch {
      reject(new Error('درخواست چندبخشی معتبر نیست.'));
      return;
    }

    const files = [];
    const fields = Object.create(null);
    const writeTasks = [];
    let totalBytes = 0;
    let failure = null;

    const fail = (message) => {
      if (!failure) failure = new Error(message);
    };

    parser.on('field', (name, value) => {
      fields[name] = value;
    });
    parser.on('fieldsLimit', () => fail('تعداد فیلدهای درخواست از حد مجاز بیشتر است.'));
    parser.on('filesLimit', () => fail('تعداد فایل‌های درخواست از حد مجاز بیشتر است.'));
    parser.on('file', (fieldName, file, info) => {
      if (!ALLOWED_FIELDS.has(fieldName)) {
        fail('نوع پیوست درخواست معتبر نیست.');
        file.resume();
        return;
      }
      if (failure) {
        file.resume();
        return;
      }

      const image = fieldName === 'cover' || fieldName === 'image';
      const perFileLimit = image ? MAX_IMAGE_UPLOAD_BYTES : MAX_FILE_UPLOAD_BYTES;
      const temporaryPath = path.join(temporaryDirectory, randomBytes(16).toString('hex'));
      const output = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 });
      const entry = {
        fieldName,
        originalName: safeOriginalName(info.filename),
        temporaryPath,
        sizeBytes: 0,
      };
      files.push(entry);

      file.on('data', (chunk) => {
        entry.sizeBytes += chunk.length;
        totalBytes += chunk.length;
        if (entry.sizeBytes > perFileLimit || totalBytes > MAX_REQUEST_UPLOAD_BYTES) {
          fail(entry.sizeBytes > perFileLimit ? 'حجم فایل از حد مجاز بیشتر است.' : 'حجم کل درخواست از حد مجاز بیشتر است.');
          file.unpipe(output);
          output.destroy();
          file.resume();
        }
      });
      file.on('limit', () => fail('حجم فایل از حد مجاز بیشتر است.'));
      output.on('error', (error) => {
        if (error.code !== 'ERR_STREAM_DESTROYED') fail('ذخیرهٔ فایل بارگذاری‌شده ناموفق بود.');
      });
      file.on('error', () => fail('بارگذاری فایل کامل نشد.'));
      const writeTask = new Promise((done) => {
        output.on('finish', done);
        output.on('close', done);
      });
      writeTasks.push(writeTask);
      file.pipe(output);
    });
    parser.on('error', () => fail('خواندن درخواست بارگذاری ناموفق بود.'));
    parser.on('close', async () => {
      await Promise.all(writeTasks);
      if (failure) {
        await Promise.all(files.map((file) => rm(file.temporaryPath, { force: true })));
        reject(failure);
        return;
      }
      if (!files.length) {
        reject(new Error('فایلی برای بارگذاری دریافت نشد.'));
        return;
      }
      resolve({ fields, files });
    });
    request.on('aborted', () => fail('بارگذاری پیش از پایان قطع شد.'));
    request.pipe(parser);
  });
}

export async function removeTemporaryFiles(files = []) {
  await Promise.all(files.map((file) => rm(file.temporaryPath, { force: true })));
}
