import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'], ['.woff2', 'font/woff2'], ['.xml', 'application/xml; charset=utf-8'],
]);

async function collectFiles(root, directory = root, assets = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, absolutePath, assets);
    } else if (entry.isFile()) {
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      const body = await readFile(absolutePath);
      assets.set(`/${relativePath}`, {
        body,
        gzip: gzipSync(body, { level: 6 }),
        brotli: brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }),
        etag: `"${createHash('sha256').update(body).digest('base64url')}"`,
        contentType: MIME_TYPES.get(path.extname(absolutePath).toLowerCase()) ?? 'application/octet-stream',
      });
    }
  }
  return assets;
}

export async function createStaticAssets(publicRoot) {
  return collectFiles(path.resolve(publicRoot));
}

function encodingQuality(header, encoding) {
  const entry = String(header ?? '').split(',').map((part) => part.trim()).find((part) => part.startsWith(`${encoding};`) || part === encoding);
  if (!entry) return 0;
  const match = /(?:^|;)\s*q=([\d.]+)/.exec(entry);
  return match ? Number(match[1]) : 1;
}

function immutablePath(pathname) {
  return /(?:\.v\d+|\.[a-f\d]{8,})\./i.test(pathname);
}

export function createStaticMiddleware(assets) {
  return function serveStatic(request, response, next) {
    if (!['GET', 'HEAD'].includes(request.method)) return next();
    let pathname;
    try {
      pathname = decodeURIComponent(request.path);
    } catch {
      return response.status(400).end();
    }
    if (pathname.includes('\\') || pathname.split('/').includes('..')) return response.status(404).end();
    let assetPath = pathname;
    if (assetPath.endsWith('/')) assetPath += 'index.html';
    else if (!path.posix.extname(assetPath)) assetPath += '/index.html';
    const asset = assets.get(assetPath);
    if (!asset) return next();

    response.setHeader('Vary', 'Accept-Encoding');
    response.setHeader('ETag', asset.etag);
    response.setHeader('Content-Type', asset.contentType);
    response.setHeader('Cache-Control', immutablePath(assetPath) ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (request.get('if-none-match')?.split(',').map((tag) => tag.trim()).includes(asset.etag)) {
      return response.status(304).end();
    }

    const accepted = request.get('accept-encoding');
    let body = asset.body;
    if (encodingQuality(accepted, 'br') > 0) {
      body = asset.brotli;
      response.setHeader('Content-Encoding', 'br');
    } else if (encodingQuality(accepted, 'gzip') > 0) {
      body = asset.gzip;
      response.setHeader('Content-Encoding', 'gzip');
    }
    response.setHeader('Content-Length', String(body.length));
    if (request.method === 'HEAD') return response.status(200).end();
    return response.status(200).send(body);
  };
}
