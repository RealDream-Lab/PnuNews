# وضعیت پیشرفت PnuNews

آخرین بررسی: ۲۰۲۶-۱۰-۲۶

## وضعیت milestoneها

- [x] **M0 — اسکلت و محیط توسعه:** فایل‌های پیکربندی و راهنما موجودند؛ سرویس MariaDB توسعه در حال اجراست و migrationها با موفقیت بررسی/اعمال شدند.
- [x] **M1 — مهاجرت و دادهٔ اولیه:** migration، seed مناطق/دسته‌ها/تنظیمات و CLIها موجودند؛ آزمون‌های مرتبط اجرا می‌شوند.
- [x] **M2 — احراز هویت:** مسیرهای گذرواژه، TOTP، نشست و دستگاه مورد اعتماد و آزمون‌های مرتبط موجودند.
- [x] **M3 — سیاست و مدیریت کاربران:** ماژول policy و APIهای مدیریت/ممیزی/منطقه موجودند.
- [x] **M4 — مدیریت خبر و فایل:** CRUD خبر، زمان‌بندی، scheduler، پردازش پیوست و پاک‌سازی محتوا موجودند.
- [x] **M5 — API عمومی:** خوراک، خبر، پیکربندی، رادیو و cache در کد موجودند.
- [x] **M6 — رابط خواننده:** برنامهٔ خواننده، PWA و picker دو مرحله‌ای استان سپس شهرستان موجودند؛ انتخاب ذخیره‌شده شناسهٔ شهر است.
- [x] **M7 — رابط مدیر:** پنل موبایل/دسکتاپ و انتخابگر تاریخ جلالی موجودند؛ ساختار HTML پنل با تست hookها بررسی می‌شود.
- [~] **M8 — تکمیل و استقرار:** README و راهنمای عملیات تکمیل شدند؛ اسکریپت‌های `make-deploy-branch.sh` و `restart.sh` اضافه شدند. syntax/help اسکریپت‌ها بررسی شد و اندازهٔ gzip اولیه حدود ۱۱۷٬۰۲۵ بایت است (کمتر از ۱۵۰ KB). نصب کامل وابستگی‌های Linux، push شاخهٔ deploy، اجرای restart روی سرور و بررسی دستی دسترس‌پذیری/end-to-end انجام نشده‌اند؛ M8 تا این بررسی‌ها نیمه‌تمام است.

## نتیجهٔ ممیزی A (2026-10-26)

- A1: working tree در آغاز فقط `PROMPT.md` untracked داشت؛ stash خالی بود و فقط `main`/`origin/main` وجود داشت.
- A2: شواهد کد و تست برای policy نقش‌ها، محدودیت مدیر شهرستان، احراز هویت دومرحله‌ای، خوراک، picker، رسانه، seed، migration و scheduler پیدا شد.
- A2 باگ قطعی یافت: `public/admin/index.html`، `public/offline.html` و دو جزء در `public/index.html` ساختار HTML خراب داشتند. در commit `631e3a9` بازسازی/اصلاح و تست رگرسیون برای تعادل تگ‌ها، hookهای JS و محتوای offline اضافه شد.
- A3: تست‌ها، ساخت دیتابیس محلی از صفر، migration و دو بار seed موفق شدند؛ شمارش seed برابر ۳۱ استان و ۴۴۸ شهرستان است.
- `PROMPT.md` اکنون ignore است؛ `uploads/.gitkeep` حذف شد تا `uploads/` هیچ‌گاه tracked نشود.
- CSP در production دیگر HTTP media را نمی‌پذیرد. HTTPS media برای پشتیبانی از URL رادیوی قابل‌تنظیم مجاز است؛ این سیاست scheme را محدود می‌کند، نه host را.
- ممیزی الگوهای secret و تاریخچه، secret واقعیِ قابل‌تأییدی نشان نداد؛ فایل‌های نمونه و fixtureهای تست در بررسی بودند.

## Step 0 — پیش‌پرواز و smoke test محلی (انجام‌شده)

- `PROMPT.md` در `.gitignore` است و tracked نیست؛ بررسی الگوهای secret در README و اسناد، موردی نیافت. مسیرها و نام containerهای عملیاتی در `docs/OPERATIONS.md` برای runbook لازم‌اند و credentialی در آن دیده نشد.
- `npm test`: ۳۷ تست موفق، ۰ شکست.
- smoke test API با دیتابیس توسعه انجام شد: ساخت super-admin از CLI، ورود و ثبت TOTP، ورود با TOTP، ساخت مدیر استان و شهرستان، رد مدیر دوم فعال همان شهرستان با HTTP 409، انتشار خبر استانی همراه تصویر JPEG پردازش‌شده به WebP و PDF، بررسی feed/detail و snapshot ناشر، دانلود فایل، و روشن/خاموش‌کردن تنظیم رادیو.
- smoke test تعاملی در Chrome headless انجام شد: انتخاب استان و سپس شهرستان از picker، نمایش خبر در feed، تغییر تم به light و dark، ورود super-admin، ثبت TOTP و نمایش backup codes، رفتن به تنظیمات، و روشن/خاموش‌کردن رادیو و بررسی player در خواننده. این آزمون DOM/تعامل مرورگر بود و ارزیابی ظاهری دستی محسوب نمی‌شود.
- Safari 27.0.1 در این Mac تأیید نشد: با وجود فعال‌شدن `Allow Remote Automation`، `safaridriver --enable` دو بار با `EXC_BAD_ACCESS`/`SIGSEGV` در `authorizationWithUser:password:` کرش کرد و ساخت WebDriver session نیز موفق نشد. این محدودیت ابزار سیستم است؛ هیچ نتیجه‌ای از این آزمون به‌عنوان تأیید Safari گزارش نمی‌شود.
- در smoke test باگ CLI یافت و اصلاح شد: `scripts/create-super-admin.js` پس از خواندن secret ورودی stdin را pause نمی‌کرد و فرایند پس از ساخت مدیر باز می‌ماند.
- پس از smoke test، حساب‌ها و خبر موقت صفر بودند، تنظیم radio قبلی (`radio_enabled=0`) برگشت، فایل‌های موقت پاک شدند و `uploads/` خالی بود.
- دامنهٔ نهایی `PUBLIC_URL` هنوز از مالک دریافت نشده است؛ در Step 7 پرسیده می‌شود.
- push/deploy، تنظیم سرور و restart تولید انجام نشده‌اند و در این مرحله انجام نمی‌شوند.
- CSP عمداً HTTPS media را برای رادیوی قابل‌تنظیم مجاز می‌کند؛ محدودیت host در نظر گرفته نشده است.

## تغییرات مشخصات که هنوز در کد/پیکربندی اعمال نشده‌اند

- تغییرات اخیر مشخصات بررسی شدند: `origin` اکنون SSH است (`git@github.com:RealDream-Lab/PnuNews.git`) و picker خواننده استان را فقط به‌عنوان مرحلهٔ ناوبری می‌گیرد و در نهایت شهر را ذخیره می‌کند؛ مورد عقب‌مانده‌ای از این دو تغییر در کد/پیکربندی مشاهده نشد.
- پیش از نخستین push باید طبق مشخصات، `ssh -T git@github.com` اجرا شود؛ این نشست push انجام نداده است.

## اعتبارسنجی

- `npm test` — ۳۷ تست موفق، ۰ شکست (پس از اصلاحات A4).
- `npm run migrate` — پس از ساخت volume تازهٔ dev موفق.
- `npm run seed` دو بار — موفق؛ شمارش نهایی: ۳۱ province، ۴۴۸ county، ۶ category و ۸ settings.
- تست ساختار HTML و hookهای پنل: موفق؛ تست CSP محیط production/development: موفق.
- `PROMPT.md` با `.gitignore` نادیده گرفته می‌شود و tracked نیست؛ `.autostart` واقعی، `.env` واقعی، `uploads/` و `node_modules/` نیز در فهرست tracked نیستند. فایل نمونهٔ `.env.dev.example` استثنای مجاز است.
- commit اصلاحات ممیزی: `631e3a9` — «اصلاح ساختار صفحه‌ها و محدودسازی CSP در production».
- `npm test` پس از اصلاح توقف ورودی تعاملی CLI: ۳۷ تست موفق، ۰ شکست.
- smoke test تعاملی Chrome headless: picker، feed، تم، ورود/TOTP، تنظیمات و player رادیو موفق؛ fixtureها پاک شدند.

## Step 1 — PUSH (انجام‌شده)

- مخزن GitHub عمومی است (`PUBLIC`). آزمون `ssh -T` موفق بود: احراز هویت با حساب `RealDream-Lab`.
- شاخهٔ `main` با push عادی و بدون force منتشر شد؛ آخرین تغییر کد در commit `f6ee01d` است.
- اجرای نخست `scripts/make-deploy-branch.sh --prepare-only` نشان داد checker نام قدیمی `sharp-linux-x64.node` را می‌خواست، در حالی‌که sharp 0.35.5 باینری نسخه‌دار `sharp-linux-x64-0.35.5.node` دارد. checker اصلاح شد و regression test اضافه شد؛ commit `f6ee01d` — «اصلاح تشخیص باینری لینوکسی sharp».
- `npm test`: ۳۸ تست موفق، ۰ شکست؛ regression test checker و `bash -n scripts/make-deploy-branch.sh` هم موفق شدند.
- `deploy` با `scripts/make-deploy-branch.sh --prepare-only` ساخته و سپس push شد. باینری sharp و libvips در شاخه از نوع ELF x86-64 هستند؛ ۲۱۳۰ فایل `node_modules/` در آن قرار دارد و بررسی مسیرهای ممنوع (`.autostart`, `.env` واقعی, `uploads/`, `PROMPT.md`) موردی نیافت.
- push اولیه به‌علت سرعت SSH کند قطع شد؛ retry با SSH keepalive موفق شد. `main` هیچ‌گاه force-push نشده است.
- گزارش Step 1 روی `main` ثبت و push شد؛ همان وضعیت مستندات نیز به `deploy` منتقل و push شد و هر دو ref در GitHub تأیید شدند.

## Step 2 — SERVER GIT SETUP (انجام‌شده)

- روی سرور، مسیر موجود `/opt/docker/nodejs/workspace/PnuNews` به مخزن GitHub متصل شد؛ `origin` همان SSH URL مورد انتظار بود و fetch هر دو شاخهٔ `main` و `deploy` موفق شد.
- شاخهٔ محلی `deploy` از `origin/deploy` ساخته و tracking شد. `git status --short --branch` پاک است.
- پوشهٔ موجود `uploads/` پس از checkout تأیید شد و حفظ شده است. مخزن عمومی است؛ Deploy key لازم نبود.

## Step 3 — SERVER CONFIG (انجام‌شده)

- روی سرور `.autostart` از `.autostart.example` ساخته شد؛ مجوز فایل `600` است.
- فقط به‌صورت امن بررسی شد که `APP_SECRET` یک مقدار ۶۴ رقمی hex معتبر است، `DB_PASSWORD` دیگر placeholder نیست و `PUBLIC_URL` تنظیم شده است؛ هیچ secretی در گزارش یا مخزن ثبت نشده.
- `PUBLIC_URL` فعلی طبق اعلام مالک موقت است؛ دامنهٔ نهایی در Step 7 تأیید و پیش از ورود واقعی اعمال می‌شود.

## Step 4 — SERVER DATABASE (انجام‌شده)

- در container `mariadb` پایگاه دادهٔ `pnu_news` با `utf8mb4` ساخته شد؛ کاربر اختصاصی `pnu_news`@`%` ساخته و دسترسی لازم به schema اعطا شد.
- اتصال با همان کاربر تأیید شد؛ query نتیجهٔ `DATABASE() = pnu_news` و `CURRENT_USER() = pnu_news@%` داد. هیچ گذرواژه‌ای در گزارش ثبت نشده است.

## Step 5 — SERVER MIGRATE / SEED / ADMIN (انجام‌شده)

- environment container `nodejs` در ابتدا متغیرهای لازم پروژه را نداشت؛ برای هر فرمان `.autostart` فقط در همان process با `bash` source شد و container پیش از زمان مقرر restart نشد.
- `migrate.js` موفق شد و `001_core.sql` را اعمال کرد؛ `seed.js` موفق شد؛ super-admin به‌صورت تعاملی ساخته شد و پیام الزام ثبت 2FA در نخستین ورود نمایش داده شد.
- هیچ username، گذرواژه یا secretی در این گزارش ثبت نشده است.

## Step 6 — FIRST ACTIVATION (انجام‌شده)

- container `nodejs` روی سرور restart شد؛ این کار مطابق هشدار عملیاتی، PnuCard را هم موقتاً restart می‌کند.
- logهای startup نشان دادند PnuNews روی پورت `3010` گوش می‌دهد و خطای واضحی در خروجی محدودشده نبود.
- بررسی داخلی `/healthz` نتیجهٔ `HTTP_STATUS=200`, `BODY=ok` داد؛ مالک هم بازشدن سایت روی دامنهٔ موقت را گزارش کرد.
- picker عمومی فعلاً شهر/استانی نشان نمی‌دهد؛ این با policy فعلی سازگار است چون فقط super-admin ساخته شده و شهرهای `auto` بدون مدیر شهرستان فعال در API عمومی دیده نمی‌شوند. این وضعیت پس از provisioning مدیران در مرحلهٔ ورود واقعی دوباره بررسی می‌شود.

## گام بعدی

- Step 7: تنظیم Nginx Proxy Manager و دریافت دامنهٔ نهایی برای `PUBLIC_URL`؛ پس از تغییر `PUBLIC_URL` باید سرویس را دوباره راه‌اندازی کرد تا قبل از ورود واقعی مقدار نهایی اعمال شود.
