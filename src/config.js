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
  });
}
