import { randomBytes } from 'node:crypto';
import express from 'express';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { canEditNews, canViewNews } from '../auth/policy.js';
import { appEvents } from '../events.js';
import { inspectUpload } from '../lib/file-types.js';
import { processImage } from '../lib/images.js';
import { receiveMultipart, removeTemporaryFiles } from '../lib/uploads.js';

class UploadValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function accessNews(pool, user, newsId) {
  const [rows] = await pool.execute(
    `SELECT n.id, n.origin_region_id, n.created_by, creator.role AS created_by_role,
            creator.region_id AS created_by_region_id, creator.is_active AS created_by_is_active
     FROM news n JOIN users creator ON creator.id = n.created_by
     WHERE n.id = ? AND n.deleted_at IS NULL`,
    [newsId],
  );
  const news = rows[0];
  if (!news) return null;
  const [regions] = await pool.query('SELECT id, parent_id, type FROM regions');
  const [settings] = await pool.execute('SELECT v FROM settings WHERE k = ?', ['peer_edit_enabled']);
  return {
    news,
    canView: canViewNews(user, news, regions),
    canEdit: canEditNews(user, news, { regions, peerEditEnabled: settings[0]?.v === '1' }),
  };
}

function auditAttachment(connection, userId, newsId, attachmentId, action, request, meta = null) {
  return connection.execute(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
     VALUES (?, ?, 'news', ?, ?, ?)`,
    [userId, action, newsId, meta ? JSON.stringify({ attachment_id: attachmentId, ...meta }) : JSON.stringify({ attachment_id: attachmentId }), request.ip ?? null],
  );
}

function imagePaths(uploadRoot, storedName) {
  return [400, 800, 1280].map((width) => path.join(uploadRoot, `${storedName}-${width}.webp`));
}

function toAttachmentResponse(row) {
  const storedName = row.stored_name ?? row.storedName;
  return {
    id: row.id,
    kind: row.kind,
    original_name: row.original_name ?? row.originalName,
    mime: row.mime,
    size_bytes: row.size_bytes ?? row.sizeBytes,
    width: row.width,
    height: row.height,
    dominant_color: row.dominant_color ?? row.dominantColor,
    ...(row.kind === 'file' ? { url: `/files/${row.id}` } : {
      src: `/media/${storedName}-800.webp`,
      srcset: [400, 800, 1280].map((width) => `/media/${storedName}-${width}.webp ${width}w`).join(', '),
    }),
  };
}

export function createNewsAttachmentRouter({ pool, uploadRoot }) {
  const router = express.Router();
  const root = path.resolve(uploadRoot);

  router.post('/:newsId/attachments', async (request, response, next) => {
    const newsId = Number(request.params.newsId);
    if (!Number.isSafeInteger(newsId) || newsId < 1) return response.status(400).json({ error: 'شناسهٔ خبر معتبر نیست.' });
    let multipart;
    const createdPaths = [];
    try {
      const current = await accessNews(pool, request.user, newsId);
      if (!current?.canView) return response.status(404).json({ error: 'خبر پیدا نشد.' });
      if (!current.canEdit) return response.status(403).json({ error: 'اجازهٔ افزودن پیوست به این خبر را ندارید.' });
      multipart = await receiveMultipart(request, root);
      const incomingImages = multipart.files.filter((file) => file.fieldName === 'cover' || file.fieldName === 'image').length;
      const incomingFiles = multipart.files.filter((file) => file.fieldName === 'file').length;
      const incomingCovers = multipart.files.filter((file) => file.fieldName === 'cover').length;
      if (incomingCovers > 1) throw new UploadValidationError('در هر درخواست فقط یک تصویر جلد می‌توان فرستاد.');

      const processed = [];
      for (const file of multipart.files) {
        const inspected = await inspectUpload(file);
        if (inspected.kind === 'cover' || inspected.kind === 'image') {
          let image;
          try {
            image = await processImage(file.temporaryPath, root, { kind: inspected.kind });
          } catch {
            throw new UploadValidationError('پردازش تصویر ناموفق بود؛ فرمت و ابعاد تصویر را بررسی کنید.', 415);
          }
          createdPaths.push(...image.variants.map((variant) => variant.path));
          processed.push({
            kind: inspected.kind,
            originalName: file.originalName,
            storedName: image.storedName,
            mime: image.mime,
            sizeBytes: image.sizeBytes,
            width: image.width,
            height: image.height,
            dominantColor: image.dominantColor,
          });
        } else {
          const storedName = `files/${randomBytes(16).toString('hex')}`;
          const finalPath = path.join(root, storedName);
          await mkdir(path.dirname(finalPath), { recursive: true });
          await rename(file.temporaryPath, finalPath);
          createdPaths.push(finalPath);
          processed.push({
            kind: 'file',
            originalName: file.originalName,
            storedName,
            mime: inspected.mime,
            sizeBytes: file.sizeBytes,
            width: null,
            height: null,
            dominantColor: null,
          });
        }
      }
      await removeTemporaryFiles(multipart.files);

      const connection = await pool.getConnection();
      const inserted = [];
      try {
        await connection.beginTransaction();
        const [newsRows] = await connection.execute('SELECT id FROM news WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [newsId]);
        if (!newsRows.length) {
          await connection.rollback();
          throw new UploadValidationError('خبر پیدا نشد.', 404);
        }
        const access = await accessNews(pool, request.user, newsId);
        if (!access?.canEdit) {
          await connection.rollback();
          throw new UploadValidationError('اجازهٔ افزودن پیوست به این خبر را ندارید.', 403);
        }
        const [countRows] = await connection.execute(
          `SELECT SUM(kind IN ('cover','image')) AS image_count, SUM(kind = 'file') AS file_count
           FROM attachments WHERE news_id = ?`,
          [newsId],
        );
        const imageCount = Number(countRows[0].image_count ?? 0);
        const fileCount = Number(countRows[0].file_count ?? 0);
        if (imageCount + incomingImages > 10 || fileCount + incomingFiles > 8) {
          await connection.rollback();
          throw new UploadValidationError('تعداد تصویر یا فایل از حد مجاز برای این خبر بیشتر است.', 409);
        }
        if (incomingCovers) {
          await connection.execute("UPDATE attachments SET kind = 'image' WHERE news_id = ? AND kind = 'cover'", [newsId]);
        }
        for (const item of processed) {
          const [result] = await connection.execute(
            `INSERT INTO attachments (news_id, kind, original_name, stored_name, mime, size_bytes, width, height, dominant_color)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [newsId, item.kind, item.originalName, item.storedName, item.mime, item.sizeBytes, item.width, item.height, item.dominantColor],
          );
          const attachment = { ...item, id: result.insertId };
          inserted.push(attachment);
          if (item.kind === 'cover') {
            await connection.execute('UPDATE news SET cover_attachment_id = ?, updated_by = ? WHERE id = ?', [result.insertId, request.user.id, newsId]);
          }
          await auditAttachment(connection, request.user.id, newsId, result.insertId, 'news.attachment_add', request, { kind: item.kind, mime: item.mime, size_bytes: item.sizeBytes });
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      appEvents.emit('news.changed', { id: newsId });
      return response.status(201).json({ attachments: inserted.map(toAttachmentResponse) });
    } catch (error) {
      await Promise.all(createdPaths.map((filePath) => rm(filePath, { force: true })));
      if (multipart) await removeTemporaryFiles(multipart.files);
      if (error instanceof UploadValidationError) return response.status(error.status).json({ error: error.message });
      if (error.message?.startsWith('حجم')) return response.status(413).json({ error: error.message });
      if (error.message && /فرمت|پسوند|محتوای فایل|ساختار|نوع فایل|UTF-8|باینری|ابعاد|HEIC/.test(error.message)) {
        return response.status(415).json({ error: error.message });
      }
      if (error.message && /چندبخشی|فیلدهای درخواست|تعداد فایل‌های درخواست|فایلی برای بارگذاری|بارگذاری پیش از پایان/.test(error.message)) {
        return response.status(400).json({ error: error.message });
      }
      return next(error);
    }
  });

  return router;
}

export function createAttachmentDeleteRouter({ pool, uploadRoot }) {
  const router = express.Router();
  const root = path.resolve(uploadRoot);
  router.delete('/:id', async (request, response, next) => {
    const attachmentId = Number(request.params.id);
    if (!Number.isSafeInteger(attachmentId) || attachmentId < 1) return response.status(400).json({ error: 'شناسهٔ پیوست معتبر نیست.' });
    try {
      const [rows] = await pool.execute(
        `SELECT a.*, n.origin_region_id, n.created_by, creator.role AS created_by_role,
                creator.region_id AS created_by_region_id, creator.is_active AS created_by_is_active
         FROM attachments a JOIN news n ON n.id = a.news_id
         JOIN users creator ON creator.id = n.created_by
         WHERE a.id = ? AND n.deleted_at IS NULL`,
        [attachmentId],
      );
      const attachment = rows[0];
      if (!attachment) return response.status(404).json({ error: 'پیوست پیدا نشد.' });
      const [regions] = await pool.query('SELECT id, parent_id, type FROM regions');
      const [settings] = await pool.execute('SELECT v FROM settings WHERE k = ?', ['peer_edit_enabled']);
      const canView = canViewNews(request.user, attachment, regions);
      const canEdit = canEditNews(request.user, attachment, { regions, peerEditEnabled: settings[0]?.v === '1' });
      if (!canView) return response.status(404).json({ error: 'پیوست پیدا نشد.' });
      if (!canEdit) return response.status(403).json({ error: 'اجازهٔ حذف این پیوست را ندارید.' });

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        if (attachment.kind === 'cover') {
          await connection.execute('UPDATE news SET cover_attachment_id = NULL, updated_by = ? WHERE id = ? AND cover_attachment_id = ?', [request.user.id, attachment.news_id, attachmentId]);
        }
        await connection.execute('DELETE FROM attachments WHERE id = ?', [attachmentId]);
        await connection.execute(
          `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
           VALUES (?, 'news.attachment_delete', 'news', ?, ?, ?)`,
          [request.user.id, attachment.news_id, JSON.stringify({ attachment_id: attachmentId }), request.ip ?? null],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      const paths = attachment.kind === 'file'
        ? [path.join(root, attachment.stored_name)]
        : imagePaths(root, attachment.stored_name);
      await Promise.all(paths.map((filePath) => rm(filePath, { force: true })));
      appEvents.emit('news.changed', { id: Number(attachment.news_id) });
      return response.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });
  return router;
}
