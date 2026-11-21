// ippanel connectivity check, no database needed. Reads the credit and the estimate of the SMS left; with --send it also
// sends ONE real test SMS (the code 123456, from your pattern) to the number you give.
//   docker exec -w /workspace/PnuNews nodejs node scripts/check-sms.js
//   docker exec -w /workspace/PnuNews nodejs node scripts/check-sms.js --send 09121234567
//   (optional) --cost 2000   the assumed cost of one SMS in rial, for the estimate
// Reads IPPANEL_* from the environment (.autostart on the server, .env.dev on the Mac). It never prints the key.
// Exit code: 0 = the credit was read (and the test SMS was accepted), 1 = something failed.
import { loadIppanelConfig } from '../src/config.js';
import { createIppanelClient } from '../src/lib/ippanel.js';
import { maskPhone, normalizePhone } from '../src/lib/reader-auth.js';

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const faNumber = new Intl.NumberFormat('fa-IR');
const KIND = {
  not_configured: 'IPPANEL_API_KEY، IPPANEL_PATTERN_CODE یا IPPANEL_FROM_NUMBER تنظیم نشده است.',
  timeout: 'پاسخی از ippanel نرسید (تایم‌اوت).',
  network: 'اتصال به ippanel برقرار نشد.',
  invalid_response: 'پاسخ ippanel قابل فهم نبود.',
  rejected: 'ippanel درخواست را نپذیرفت.',
};
const why = (result) => `${KIND[result.kind] ?? result.kind}${result.messageCode ? ` (کد ${result.messageCode})` : ''}${result.status ? ` [HTTP ${result.status}]` : ''}`;

try {
  const config = loadIppanelConfig();
  const client = createIppanelClient(config);
  console.info(`آدرس: ${config.baseUrl}  | کلید: ${config.apiKey ? 'تنظیم شده' : 'تنظیم نشده'}  | پترن: ${config.patternCode ? 'تنظیم شده' : 'تنظیم نشده'}  | فرستنده: ${config.fromNumber || 'تنظیم نشده'}${config.dryRun ? '  | حالت آزمایشی (DRY_RUN)' : ''}`);
  if (!client.configured) throw new Error(KIND.not_configured);

  const credit = await client.getCredit();
  if (!credit.ok) throw new Error(`خواندن اعتبار ناموفق بود: ${why(credit)}`);
  const cost = Number(option('--cost') ?? 2000);
  console.info(`اعتبار: ${faNumber.format(Math.floor(credit.credit))} ریال (${faNumber.format(Math.floor(credit.credit / 10))} تومان)`);
  if (Number.isFinite(cost) && cost > 0) console.info(`حدود ${faNumber.format(Math.floor(credit.credit / cost))} پیامک باقی است (با هزینهٔ ${faNumber.format(cost)} ریال برای هر پیامک).`);

  const target = option('--send');
  if (target !== undefined) {
    const phone = normalizePhone(target);
    if (!phone) throw new Error('شمارهٔ --send معتبر نیست؛ مثلاً 09121234567.');
    console.info(`در حال ارسال یک پیامک آزمایشی (کد 123456) به ${maskPhone(phone)} ...`);
    const sent = await client.sendPattern(phone, '123456');
    if (!sent.ok) throw new Error(`ارسال ناموفق بود: ${why(sent)}`);
    console.info(`OK: پیامک پذیرفته شد (شناسهٔ ارسال ${sent.outboxId}).`);
  } else {
    console.info('برای فرستادن یک پیامک آزمایشی واقعی: --send 09121234567');
  }
} catch (error) {
  console.error(`ناموفق: ${error.message}`);
  process.exitCode = 1;
}
