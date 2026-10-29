import express from 'express';
import { brandNameOutput } from './lib/brand-output.js';
import { resolveNowPlayingUrl } from './lib/nowplaying.js';
import { createAuthRouter } from './routes/auth.js';
import { createAdminRouter } from './routes/admin.js';
import { createMediaRouter } from './routes/media.js';
import { createPublicRouter } from './routes/public.js';
import { createStaticMiddleware } from './lib/static.js';

// connectOrigins: the radio server, so the player can read "now playing" straight from the visitor's browser
// when this server cannot reach it.
export function contentSecurityPolicy(publicUrl, connectOrigins = []) {
  const mediaSources = publicUrl.startsWith('https://') ? "'self' https:" : "'self' https: http:";
  const connect = connectOrigins.length ? `connect-src 'self' ${connectOrigins.join(' ')}; ` : '';
  return `default-src 'self'; ${connect}img-src 'self' blob: data: https://pnu.ac.ir; media-src ${mediaSources}; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
}

function csrfGuard(request, response, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
  const multipartUpload = request.method === 'POST' &&
    /^\/api\/admin\/news\/\d+\/attachments$/.test(request.path) &&
    request.is('multipart/form-data');
  if (!request.is('application/json') && !multipartUpload) {
    return response.status(415).json({ error: 'درخواست باید از نوع JSON باشد.' });
  }

  const origin = request.get('origin');
  const fetchSite = request.get('sec-fetch-site');
  const expectedOrigin = `${request.protocol}://${request.get('host')}`;
  const originIsSame = origin && (() => {
    try {
      return new URL(origin).origin === new URL(expectedOrigin).origin;
    } catch {
      return false;
    }
  })();
  const fetchSiteIsSame = fetchSite === 'same-origin';
  const requestIsSameOrigin = origin ? Boolean(originIsSame) : fetchSiteIsSame;
  if (!requestIsSameOrigin) {
    return response.status(403).json({ error: 'مبدأ درخواست معتبر نیست.' });
  }
  return next();
}

export function createApp({ pool, config, clock = Date.now, fetchImpl = fetch, staticAssets, portalImporter = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  // The radio origin comes from the settings table; it is cached briefly so the header costs no query per request.
  let radioOrigins = { value: [], expiresAt: 0 };
  async function currentRadioOrigins() {
    if (radioOrigins.expiresAt > clock()) return radioOrigins.value;
    let value = [];
    try {
      const [rows] = await pool.query("SELECT k, v FROM settings WHERE k IN ('radio_enabled', 'radio_nowplaying_url', 'radio_stream_url')");
      const settings = Object.fromEntries(rows.map((row) => [row.k, row.v]));
      if (settings.radio_enabled === '1') {
        const url = resolveNowPlayingUrl({ nowPlayingUrl: settings.radio_nowplaying_url, streamUrl: settings.radio_stream_url });
        if (url && (url.protocol === 'https:' || (url.protocol === 'http:' && !config.publicUrl.startsWith('https://')))) value = [url.origin];
      }
    } catch {}
    radioOrigins = { value, expiresAt: clock() + 30_000 };
    return value;
  }
  app.use(async (request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', contentSecurityPolicy(config.publicUrl, await currentRadioOrigins()));
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.publicUrl.startsWith('https://')) {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    next();
  });
  // Authentication and admin responses (sessions state, temporary passwords, audit log) must never be cached.
  app.use(['/api/auth', '/api/admin'], (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    next();
  });
  app.use('/api', brandNameOutput);
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use(csrfGuard);

  app.get('/healthz', (request, response) => response.type('text/plain').send('ok'));
  app.use('/api/auth', createAuthRouter({ pool, config, clock }));
  app.use('/api/admin', createAdminRouter({ pool, config, clock, uploadRoot: config.uploadDir, portalImporter, fetchImpl }));
  app.use(createPublicRouter({ pool, config, clock, fetchImpl, staticAssets }));
  app.use(createMediaRouter({ pool, uploadRoot: config.uploadDir }));
  if (staticAssets) app.use(createStaticMiddleware(staticAssets));
  app.use('/api', (request, response) => response.status(404).json({ error: 'مسیر پیدا نشد.' }));
  app.use((error, request, response, next) => {
    console.error(`Request failed: ${error.message}`);
    if (response.headersSent) return next(error);
    return response.status(error.status === 400 ? 400 : 500).json({ error: 'درخواست قابل پردازش نیست.' });
  });
  return app;
}
