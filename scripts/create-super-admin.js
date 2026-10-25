import readline from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { createPool } from '../src/db.js';
import { hashPassword } from '../src/auth/crypto.js';
import { loadConfig } from '../src/config.js';

function askLine(prompt) {
  const interfaceReader = createInterface({ input: process.stdin, output: process.stdout });
  return interfaceReader.question(prompt).finally(() => interfaceReader.close());
}

function askSecret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('این فرمان باید در ترمینال تعاملی اجرا شود.\nRun this command in an interactive terminal.');
  }
  readline.emitKeypressEvents(process.stdin);
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.off('keypress', onKeypress);
      process.stdout.write('\n');
    };
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('عملیات لغو شد.'));
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(value);
      } else if (key.name === 'backspace') {
        value = value.slice(0, -1);
      } else if (character && !key.ctrl && !key.meta) {
        value += character;
      }
    };
    process.stdin.on('keypress', onKeypress);
  });
}

async function main() {
  const username = (await askLine('نام کاربری: ')).trim();
  const fullName = (await askLine('نام و نام خانوادگی: ')).trim();
  if (!/^[\p{L}\p{N}_.-]{3,80}$/u.test(username)) throw new Error('نام کاربری باید ۳ تا ۸۰ نویسهٔ مجاز داشته باشد.');
  if (!fullName || fullName.length > 160) throw new Error('نام کامل معتبر نیست.');
  const password = await askSecret('گذرواژه (هنگام تایپ نمایش داده نمی‌شود): ');
  const confirmation = await askSecret('تکرار گذرواژه: ');
  if (password.length < 10 || password.toLocaleLowerCase() === username.toLocaleLowerCase()) {
    throw new Error('گذرواژه باید دست‌کم ۱۰ نویسه باشد و با نام کاربری یکسان نباشد.');
  }
  if (password !== confirmation) throw new Error('گذرواژه‌ها یکسان نیستند.');

  const config = loadConfig();
  const pool = createPool(config.db);
  try {
    const [regions] = await pool.execute('SELECT id FROM regions WHERE code = ?', ['IR']);
    if (!regions.length) throw new Error('منطقهٔ ریشه پیدا نشد؛ ابتدا npm run seed را اجرا کنید.');
    const passwordHash = await hashPassword(password);
    const [result] = await pool.execute(
      `INSERT INTO users (username, password_hash, full_name, role, region_id, is_active, must_change_password, password_changed_at)
       VALUES (?, ?, ?, 'super_admin', ?, 1, 0, UTC_TIMESTAMP())`,
      [username, passwordHash, fullName, regions[0].id],
    );
    await pool.execute(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, meta)
       VALUES (?, 'user.create_cli', 'user', ?, JSON_OBJECT('role', 'super_admin'))`,
      [result.insertId, result.insertId],
    );
    console.info('حساب مدیر ارشد ساخته شد. در نخستین ورود، ثبت احراز هویت دومرحله‌ای الزامی است.');
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(`ساخت مدیر ارشد ناموفق بود.\nSuper-admin creation failed: ${error.message}`);
  process.exitCode = 1;
}
