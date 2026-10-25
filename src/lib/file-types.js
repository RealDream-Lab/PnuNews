import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { detectImageMime } from './images.js';

const imageExtensions = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.heic', 'image/heic'],
]);
const allowedFiles = new Map([
  ['.pdf', { mime: 'application/pdf', type: 'pdf' }],
  ['.doc', { mime: 'application/msword', type: 'ole' }],
  ['.xls', { mime: 'application/vnd.ms-excel', type: 'ole' }],
  ['.ppt', { mime: 'application/vnd.ms-powerpoint', type: 'ole' }],
  ['.docx', { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', type: 'zip' }],
  ['.xlsx', { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', type: 'zip' }],
  ['.pptx', { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', type: 'zip' }],
  ['.zip', { mime: 'application/zip', type: 'zip' }],
  ['.txt', { mime: 'text/plain; charset=utf-8', type: 'text' }],
  ['.csv', { mime: 'text/csv; charset=utf-8', type: 'text' }],
]);

export async function inspectUpload(file) {
  const extension = path.extname(file.originalName).toLowerCase();
  const handle = await open(file.temporaryPath, 'r');
  const header = Buffer.alloc(32);
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < header.length) header.fill(0, bytesRead);
  } finally {
    await handle.close();
  }
  const imageMime = detectImageMime(header);
  if (imageMime) {
    if (file.fieldName === 'file' || imageExtensions.get(extension) !== imageMime) {
      throw new Error('پسوند نام فایل با نوع واقعی تصویر سازگار نیست.');
    }
    return { kind: file.fieldName === 'cover' ? 'cover' : 'image', mime: imageMime };
  }
  if (imageExtensions.has(extension)) throw new Error('محتوای فایل تصویر معتبر نیست.');

  const allowed = allowedFiles.get(extension);
  if (!allowed || file.fieldName !== 'file') throw new Error('نوع فایل پیوست مجاز نیست.');
  if (allowed.type === 'pdf' && !header.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error('ساختار PDF معتبر نیست.');
  }
  if (allowed.type === 'zip' && !header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new Error('ساختار ZIP یا سند Office معتبر نیست.');
  }
  if (allowed.type === 'ole' && !header.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw new Error('ساختار سند Office معتبر نیست.');
  }
  if (allowed.type === 'text') {
    const bytes = await readFile(file.temporaryPath);
    if (bytes.includes(0)) throw new Error('فایل متنی دارای دادهٔ باینری است.');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('فایل متنی باید UTF-8 معتبر باشد.');
    }
  }
  return { kind: 'file', mime: allowed.mime };
}
