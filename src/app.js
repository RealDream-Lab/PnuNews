import express from 'express';
import { createAuthRouter } from './routes/auth.js';
import { createAdminRouter } from './routes/admin.js';

function csrfGuard(request, response, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
  if (!request.is('application/json')) {
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

export function createApp({ pool, config, clock = Date.now }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-ancestors 'none'");
    next();
  });
  app.use(express.json({ limit: '100kb', strict: true }));
  app.use(csrfGuard);

  app.get('/healthz', (request, response) => response.type('text/plain').send('ok'));
  app.use('/api/auth', createAuthRouter({ pool, config, clock }));
  app.use('/api/admin', createAdminRouter({ pool, config }));
  app.use('/api', (request, response) => response.status(404).json({ error: 'مسیر پیدا نشد.' }));
  app.use((error, request, response, next) => {
    console.error(`Request failed: ${error.message}`);
    if (response.headersSent) return next(error);
    return response.status(error.status === 400 ? 400 : 500).json({ error: 'درخواست قابل پردازش نیست.' });
  });
  return app;
}
