import express from 'express';
import { access } from 'node:fs/promises';
import path from 'node:path';

function resolveStoredPath(root, storedName) {
  const filePath = path.resolve(root, storedName);
  if (!filePath.startsWith(`${root}${path.sep}`)) return null;
  return filePath;
}

export function createMediaRouter({ pool, uploadRoot }) {
  const router = express.Router();
  const root = path.resolve(uploadRoot);

  router.get('/media/img/:year/:month/:file', async (request, response, next) => {
    const { year, month, file } = request.params;
    if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) return response.status(404).end();
    const match = /^([a-f\d]{32})-(400|800|1280)\.webp$/i.exec(file);
    if (!match) return response.status(404).end();
    const storedName = `img/${year}/${month}/${match[1]}`;
    try {
      const [rows] = await pool.execute(
        `SELECT a.stored_name FROM attachments a JOIN news n ON n.id = a.news_id
         WHERE a.stored_name = ? AND a.kind IN ('cover','image') AND a.mime = 'image/webp'
           AND n.status = 'published' AND n.published_at <= UTC_TIMESTAMP() AND n.deleted_at IS NULL
           AND (n.expires_at IS NULL OR n.expires_at > UTC_TIMESTAMP()) LIMIT 1`,
        [storedName],
      );
      if (!rows.length) return response.status(404).end();
      const filePath = resolveStoredPath(root, `${storedName}-${match[2]}.webp`);
      if (!filePath) return response.status(404).end();
      await access(filePath);
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      response.type('image/webp');
      return response.sendFile(filePath, (error) => {
        if (error && !response.headersSent) next(error);
      });
    } catch (error) {
      if (error.code === 'ENOENT') return response.status(404).end();
      return next(error);
    }
  });

  router.get('/files/:id', async (request, response, next) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return response.status(404).end();
    try {
      const [rows] = await pool.execute(
        `SELECT a.stored_name, a.original_name, a.mime
         FROM attachments a JOIN news n ON n.id = a.news_id
         WHERE a.id = ? AND a.kind = 'file' AND n.status = 'published'
           AND n.published_at <= UTC_TIMESTAMP() AND n.deleted_at IS NULL
           AND (n.expires_at IS NULL OR n.expires_at > UTC_TIMESTAMP()) LIMIT 1`,
        [id],
      );
      const attachment = rows[0];
      if (!attachment || !/^files\/[a-f\d]{32}$/i.test(attachment.stored_name)) return response.status(404).end();
      const filePath = resolveStoredPath(root, attachment.stored_name);
      if (!filePath) return response.status(404).end();
      await access(filePath);
      const fallback = attachment.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 120) || 'download';
      const encodedName = encodeURIComponent(attachment.original_name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodedName}`);
      response.setHeader('Content-Type', 'application/octet-stream');
      return response.sendFile(filePath, (error) => {
        if (error && !response.headersSent) next(error);
      });
    } catch (error) {
      if (error.code === 'ENOENT') return response.status(404).end();
      return next(error);
    }
  });

  return router;
}
