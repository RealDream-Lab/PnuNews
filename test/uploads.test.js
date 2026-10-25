import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { inspectUpload } from '../src/lib/file-types.js';
import { MAX_IMAGE_UPLOAD_BYTES, receiveMultipart } from '../src/lib/uploads.js';

function multipartRequest({ boundary, field = 'file', filename, content }) {
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const request = Readable.from([header, content, footer]);
  request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return request;
}

test('multipart upload parser streams files and validates their real signature against extension', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pnunews-upload-'));
  try {
    const boundary = 'pnu-boundary';
    const content = Buffer.from('%PDF-1.7\nvalid test data');
    const parsed = await receiveMultipart(multipartRequest({ boundary, filename: '../../notice.pdf', content }), root);
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].originalName, 'notice.pdf');
    assert.deepEqual(await inspectUpload(parsed.files[0]), { kind: 'file', mime: 'application/pdf' });

    const forged = { ...parsed.files[0], originalName: 'notice.exe' };
    await assert.rejects(inspectUpload(forged), /مجاز/);
    const badPdfPath = path.join(root, 'bad-pdf');
    await writeFile(badPdfPath, 'not a pdf');
    await assert.rejects(inspectUpload({ fieldName: 'file', originalName: 'spoofed.pdf', temporaryPath: badPdfPath }), /PDF/);
    const svgPath = path.join(root, 'vector');
    await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await assert.rejects(inspectUpload({ fieldName: 'image', originalName: 'vector.svg', temporaryPath: svgPath }), /مجاز/);
    await rm(root, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('multipart parser rejects images over the 12 MB limit and cleans temporary files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pnunews-upload-limit-'));
  try {
    const boundary = 'pnu-limit-boundary';
    const content = Buffer.alloc(MAX_IMAGE_UPLOAD_BYTES + 1, 0x41);
    content.set([0xff, 0xd8, 0xff], 0);
    await assert.rejects(
      receiveMultipart(multipartRequest({ boundary, field: 'image', filename: 'large.jpg', content }), root),
      /حجم فایل/,
    );
    assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
