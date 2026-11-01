const required = [
  'PORT',
  'NODE_ENV',
  'PUBLIC_URL',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'APP_SECRET',
  'UPLOAD_DIR',
];

// Values shipped in .env.dev.example; they are public, so they must never run in production.
const KNOWN_DEV_SECRETS = new Set([
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'pnu_news_dev_only',
  'root_dev_only',
]);

export function loadConfig(env = process.env) {
  const missing = required.filter((key) => !env[key] || env[key].includes('CHANGE_ME'));
  if (missing.length) {
    throw new Error(
      `تنظیمات لازم موجود نیست یا مقدار نمونه دارد: ${missing.join(', ')}\n` +
      `Missing required configuration: ${missing.join(', ')}`,
    );
  }

  const port = Number(env.PORT);
  const dbPort = Number(env.DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT باید یک عدد معتبر بین ۱ تا ۶۵۵۳۵ باشد.\nPORT must be an integer from 1 to 65535.');
  }
  if (!Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535) {
    throw new Error('DB_PORT باید یک عدد معتبر باشد.\nDB_PORT must be a valid port number.');
  }
  if (!/^https?:\/\//.test(env.PUBLIC_URL)) {
    throw new Error('PUBLIC_URL باید با http:// یا https:// شروع شود.\nPUBLIC_URL must use http:// or https://.');
  }
  if (!/^[a-f\d]{64}$/i.test(env.APP_SECRET)) {
    throw new Error('APP_SECRET باید دقیقاً ۶۴ رقم هگزادسیمال باشد.\nAPP_SECRET must be exactly 64 hexadecimal characters.');
  }

  if (env.NODE_ENV === 'production') {
    if (!env.PUBLIC_URL.startsWith('https://')) {
      throw new Error('در حالت production، PUBLIC_URL باید با https:// شروع شود (کوکی‌های نشست فقط روی HTTPS کار می‌کنند).\nPUBLIC_URL must use https:// in production.');
    }
    if (KNOWN_DEV_SECRETS.has(env.APP_SECRET) || KNOWN_DEV_SECRETS.has(env.DB_PASSWORD) || /^(.)\1{63}$/.test(env.APP_SECRET)) {
      throw new Error('APP_SECRET یا DB_PASSWORD مقدار نمونهٔ عمومی یا ضعیف دارد؛ مقدار تصادفی تازه بسازید (مثلاً openssl rand -hex 32).\nAPP_SECRET or DB_PASSWORD is a public sample/weak value; generate a fresh one.');
    }
  }

  return Object.freeze({
    port,
    nodeEnv: env.NODE_ENV,
    publicUrl: env.PUBLIC_URL.replace(/\/$/, ''),
    trustProxy: env.TRUST_PROXY === '1',
    db: Object.freeze({
      host: env.DB_HOST,
      port: dbPort,
      database: env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
    }),
    appSecret: env.APP_SECRET,
    uploadDir: env.UPLOAD_DIR,
    // Host names that may resolve to private addresses for the radio "now playing" request (set by the server operator).
    radioTrustedHosts: Object.freeze(String(env.RADIO_TRUSTED_HOSTS ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean)),
  });
}
