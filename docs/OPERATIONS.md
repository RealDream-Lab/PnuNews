# راهنمای عملیات

## توسعهٔ محلی

1. Node.js نسخهٔ 24 یا بالاتر و Docker Desktop را نصب کنید.
2. `.env.dev.example` را به `.env.dev` کپی کنید؛ فایل `.env.dev` محرمانه است و نباید commit شود.
3. سرویس پایگاه داده را اجرا کنید: `docker compose -f docker-compose.dev.yml up -d`.
4. وابستگی‌ها و جداول را آماده کنید: `npm install` و `npm run migrate`.
5. دادهٔ پایه را بارگذاری کنید: `npm run seed`.
6. برای محیط محلی، `npm run create-admin` را در ترمینال تعاملی اجرا کنید.
7. با `npm run dev` برنامه را اجرا کنید.

پایگاه دادهٔ توسعه از دادهٔ پایدار volume داکر استفاده می‌کند. حذف volume آن را پاک می‌کند.

## تولید

### الزامات و فایل محرمانه

- سرور موجود Ubuntu و کانتینر `nodejs` با Node 24 است. پروژه در `/opt/docker/nodejs/workspace/PnuNews` (داخل کانتینر `/workspace/PnuNews`) قرار می‌گیرد.
- پیش از اجرا، `.autostart.example` را در سرور به `.autostart` کپی و مقادیر واقعی را فقط همان‌جا تنظیم کنید. این فایل توسط bash خوانده می‌شود؛ فضای اطراف `=` نگذارید و مقدارهای دارای فاصله یا `$`, `&`, `;` را تک‌نقل‌قولی کنید.
- `APP_SECRET` را روی سرور بسازید: `openssl rand -hex 32`. آن را در پیام، مخزن یا گزارش‌ها قرار ندهید. مقدار `CHANGE_ME` را باقی نگذارید.
- `UPLOAD_DIR` باید `/workspace/PnuNews/uploads` باشد و پوشه برای کاربر فرایند قابل نوشتن بماند. `PORT=3010`، `PUBLIC_URL` و تنظیمات DB باید با `.autostart.example` هماهنگ باشند.
- سایت عمومی را پشت Authelia قرار ندهید. reverse proxy باید به `nodejs:3010` متصل شود.

### اتصال SSH به GitHub و دریافت اولیه — توقف برای تأیید مالک

remote مخزن باید فقط SSH باشد: `git@github.com:RealDream-Lab/PnuNews.git`. پیش از نخستین push، روی Mac اجرا کنید:

```sh
ssh -T git@github.com
git remote -v
```

اگر احراز هویت SSH موفق نیست، توقف کنید و کلید عمومی را در حساب GitHub خود اضافه کنید؛ کلید خصوصی را به کسی ندهید. اگر مخزن خصوصی است، سرور به deploy key فقط‌خواندنی نیاز دارد. روی سرور کلید بسازید و فقط کلید عمومی را در Settings → Deploy keys مخزن ثبت کنید:

```sh
ssh-keygen -t ed25519 -C "pnunews-server-readonly"
ssh -T git@github.com
```

پوشهٔ `PnuNews/` روی سرور از قبل وجود دارد و `uploads/` آن باید حفظ شود؛ در آن پوشه `git clone` اجرا نکنید. برای دریافت اولیه از پوشهٔ موجود استفاده کنید:

```sh
cd /opt/docker/nodejs/workspace/PnuNews
git init -b main
git remote add origin git@github.com:RealDream-Lab/PnuNews.git
git fetch origin
git checkout -t origin/main
```

اگر از شاخهٔ `deploy` استفاده می‌کنید، در دستور آخر `origin/deploy` را جایگزین کنید. سپس `.autostart` را از `.autostart.example` بسازید و تنظیم کنید.

### ایجاد پایگاه دادهٔ تولید — توقف برای تأیید مالک

مالک باید پایگاه داده و کاربر اختصاصی را روی سرور ایجاد کند. گذرواژهٔ قوی انتخاب و فقط در `.autostart` ثبت شود؛ از گذرواژهٔ root استفاده نکنید. در MariaDB:

```sh
docker exec -it mariadb mariadb -u root -p
```

```sql
CREATE DATABASE pnu_news CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'pnu_news'@'%' IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON pnu_news.* TO 'pnu_news'@'%';
FLUSH PRIVILEGES;
```

به‌جای `CHANGE_ME_STRONG_PASSWORD` گذرواژهٔ تولیدی را وارد کنید. پس از آن، مالک اتصال را با این دستور بررسی کند:

```sh
docker exec -it mariadb mariadb -u pnu_news -p pnu_news -e "SELECT DATABASE(), CURRENT_USER();"
```

### وابستگی‌ها و راه‌اندازی

به‌دلیل محدودیت فعلی دسترسی npm در سرور، وابستگی‌ها را با یکی از دو روش آماده کنید:

1. اگر دسترسی npm سرور برقرار است، روی سرور اجرا کنید: `docker exec -w /workspace/PnuNews nodejs npm ci --omit=dev`.
2. اگر registry در سرور در دسترس نیست، روی Mac اسکریپت `scripts/make-deploy-branch.sh` را اجرا کنید. اسکریپت وابستگی‌های production برای Linux x86_64/glibc را می‌سازد، وجود باینری‌های `sharp` را بررسی می‌کند و پیش از push شاخهٔ `deploy` تأیید می‌گیرد. با `scripts/make-deploy-branch.sh --prepare-only` فقط شاخهٔ محلی ساخته می‌شود. شاخهٔ `deploy` بزرگ‌تر است، شامل `node_modules/` لینوکسی است و برای کار روزمره استفاده نشود.

بعد از اطمینان از وجود وابستگی‌ها و `.autostart`، seed را یک‌بار اجرا کنید و مدیر ارشد را به‌صورت تعاملی بسازید:

```sh
docker exec -w /workspace/PnuNews nodejs node scripts/migrate.js
docker exec -w /workspace/PnuNews nodejs node scripts/seed.js
docker exec -it -w /workspace/PnuNews nodejs node scripts/create-super-admin.js
```

سرور در هر شروع، migrationهای اعمال‌نشده را با قفل MariaDB اجرا می‌کند. seed به‌صورت خودکار در startup اجرا نمی‌شود. مدیر ارشد در نخستین ورود باید 2FA را ثبت کند.

برای فعال‌سازی اولیه، `start-all.sh` فقط در شروع کانتینر پوشه‌های دارای `.autostart` را می‌خواند. پس از هماهنگی زمان کم‌ترافیک، `docker restart nodejs` را اجرا کنید؛ این کار موقتاً PnuCard را نیز restart می‌کند.

### به‌روزرسانی عادی

این سرور روی شاخهٔ `deploy` است؛ push کردن `main` به‌تنهایی شاخهٔ سرور را به‌روز نمی‌کند. روی Mac، پس از تغییر و تست:

```sh
git add <فایل‌های-تغییریافته>
git commit -m "پیام فارسی"
git push origin main
scripts/make-deploy-branch.sh
```

`make-deploy-branch.sh` وابستگی‌های تولید Linux x86_64/glibc را از `main` می‌سازد، باینری‌های sharp را بررسی می‌کند و پیش از push شاخهٔ `deploy` تأیید می‌گیرد. کامیت جدید `deploy` همیشه `origin/deploy` را پدر خود دارد؛ بنابراین push عادی است (بدون force) و روی سرور `git pull --ff-only` کافی است. هرگز `main` را force-push نکنید.

پس از موفقیت build/push، روی سرور:

```sh
cd /opt/docker/nodejs/workspace/PnuNews
git pull --ff-only
docker exec nodejs bash /workspace/PnuNews/scripts/restart.sh
```

اسکریپت restart فقط پردازشی را که هم working directory آن `/workspace/PnuNews` و هم فرمانش `node server.js` است با `SIGTERM` متوقف می‌کند؛ `start-all.sh` پس از چند ثانیه همان برنامه را بالا می‌آورد. اگر یک یا چند پردازش دقیق پیدا نشود، اسکریپت از توقف هر پردازشی خودداری می‌کند. migrationهای جدید در startup اجرا می‌شوند.

### زمان‌بندی خبرگیری از پورتال با cron یا systemd (اختیاری)

به‌طور پیش‌فرض خود برنامه هر ۱۰ دقیقه خبرهای پورتال را می‌گیرد (`PORTAL_FETCH_MODE` تنظیم نشده یا `internal`). اگر می‌خواهید این کار به‌جای برنامه توسط سیستم‌عامل یا Docker زمان‌بندی شود:

1. در `.autostart` سرور مقدار `PORTAL_FETCH_MODE=external` را بگذارید و برنامه را restart کنید (زمان‌بند داخلی خاموش می‌شود). برنامه در این حالت هر ۳۰ ثانیه ردیف‌های تازهٔ پورتال را در پایگاه داده می‌بیند تا کش و به‌روزرسانی زندهٔ خوانندگان همچنان کار کند.
2. یکی از دو روش زیر را روی میزبان فعال کنید. هر دو `scripts/fetch-portal-news.sh` را داخل کانتینر `nodejs` اجرا می‌کنند؛ این اسکریپت `.autostart` را می‌خواند، با `flock` از هم‌زمانی دو اجرا جلوگیری می‌کند و بعد از ۱۲۰ ثانیه متوقف می‌شود.

**cron میزبان:**

```sh
sudo cp scripts/cron/pnunews-portal.crontab /etc/cron.d/pnunews-portal
```

**systemd timer:**

```sh
sudo cp scripts/cron/pnunews-portal.service scripts/cron/pnunews-portal.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pnunews-portal.timer
systemctl list-timers pnunews-portal.timer
journalctl -u pnunews-portal.service -n 20
```

اجرای دستی برای آزمایش: `docker exec nodejs bash /workspace/PnuNews/scripts/fetch-portal-news.sh` (با `--force` حتی اگر کلید پنل مدیریت خاموش باشد). کد خروجی `0` یعنی موفق یا «خاموش»، و `1` یعنی دریافت ناموفق بوده است. کلید روشن/خاموش و دکمهٔ «دریافت اکنون» در پنل مدیریت در هر دو حالت کار می‌کنند. اگر برنامه با Docker Compose جدا از این سرور اجرا می‌شود، همان فرمان را با `docker compose exec <service> bash scripts/fetch-portal-news.sh` یا یک سرویس کمکی با `restart: unless-stopped` و حلقهٔ `while true; do bash scripts/fetch-portal-news.sh; sleep 600; done` اجرا کنید.

### اکنون‌پخش رادیو (متای آهنگ)

نوار رادیو نام آهنگ را از سرور برنامه می‌گیرد، نه مستقیم از مرورگر: سرور برنامه نشانی «اکنون‌پخش» (مثلاً `https://radiostream.pnu.ac.ir/api/nowplaying/1`) را می‌خواند. اگر خالی باشد، `/api/nowplaying` همان سرورِ نشانی پخش آزمایش می‌شود. قالب‌های AzuraCast (یک ایستگاه یا آرایهٔ همهٔ ایستگاه‌ها)، Icecast و Shoutcast خوانده می‌شود و ریدایرکت‌ها دنبال می‌شوند.

اگر به‌جای نام آهنگ فقط «پخش زندهٔ رادیو» دیده می‌شود: در پنل مدیریت → تنظیمات → «آزمایش اکنون‌پخش» را بزنید؛ دلیل دقیق را می‌نویسد (دامنه به نشانی داخلی می‌رسد، اتصال برقرار نمی‌شود، گواهی TLS، پاسخ غیر JSON و …). دلیل در لاگ سرور هم با عبارت `Radio now-playing could not be read` ثبت می‌شود. اگر سرور برنامه اصلاً به سرور رادیو نمی‌رسد (خطای TimeoutError)، پاسخ `/api/public/radio` شامل `reachable: false` می‌شود و پخش‌کنندهٔ سایت نام آهنگ را مستقیم از مرورگر بازدیدکننده می‌خواند؛ برای این کار سرور رادیو باید CORS را مجاز کرده باشد (در AzuraCast پیش‌فرض است) و برنامه خودش میزبان رادیو را به `connect-src` سیاست امنیتی محتوا (CSP) اضافه می‌کند. اگر نام دامنه از دید سرور برنامه به نشانی داخلی (مثل ۱۰.x) resolve می‌شود، برای جلوگیری از SSRF رد می‌شود؛ در این صورت در `.autostart` بنویسید `RADIO_TRUSTED_HOSTS=radiostream.pnu.ac.ir` و برنامه را restart کنید.

### reverse proxy — توقف برای تأیید مالک

در Nginx Proxy Manager → Proxy Hosts → Add:

- دامنه: `news.pnu.ac.ir` (یا دامنهٔ نهایی)، Scheme: `http`، Forward Hostname: `nodejs`، Forward Port: `3010`.
- Block Common Exploits را روشن کنید؛ Websockets لازم نیست.
- گواهی TLS بگیرید/وصل کنید، Force SSL و HTTP/2 را روشن کنید.
- Access List و Authelia تنظیم نکنید.
- در Advanced این موارد را اضافه کنید: `client_max_body_size 30m;` و `proxy_read_timeout 60s;`.

## پشتیبان‌گیری و بازیابی

از پایگاه داده و `uploads/` هر دو نسخهٔ پشتیبان بگیرید؛ فایل‌های بارگذاری‌شده بیرون از dump دیتابیس هستند. نسخه‌ها را در مکانی امن خارج از پوشهٔ برنامه و خارج از مخزن نگه دارید.

نمونهٔ پشتیبان دیتابیس با ورود تعاملی برای گذرواژه (روی میزبان سرور):

```sh
docker exec -it mariadb sh
mariadb-dump --single-transaction -u pnu_news -p pnu_news > /tmp/pnu_news.sql
exit
docker cp mariadb:/tmp/pnu_news.sql ./pnu_news-backup.sql
```

برای فایل‌ها، روی میزبان سرور:

```sh
tar -czf pnunews-uploads-backup.tar.gz -C /opt/docker/nodejs/workspace/PnuNews uploads
```

پس از گرفتن نسخهٔ پشتیبان، فایل موقت داخل کانتینر را حذف کنید: `docker exec mariadb rm -f /tmp/pnu_news.sql`.

بازیابی را فقط پس از توقف کنترل‌شدهٔ برنامه انجام دهید و ابتدا از وضعیت فعلی نیز نسخهٔ پشتیبان بگیرید. فایل SQL را به کانتینر کپی و با کاربر `pnu_news` به‌صورت تعاملی وارد کنید:

```sh
docker cp ./pnu_news-backup.sql mariadb:/tmp/pnu_news-restore.sql
docker exec -it mariadb mariadb -u pnu_news -p pnu_news
```

در prompt برنامهٔ MariaDB اجرا کنید: `SOURCE /tmp/pnu_news-restore.sql;` و سپس `exit`. برای فایل‌ها، آرشیو را در مسیر پروژه باز کنید تا پوشهٔ `uploads/` برگردد. پس از اطمینان از داده‌ها، برنامه را دوباره راه‌اندازی کنید.

## نگهداری کاربران

- مدیر ارشد از پنل دسکتاپ یک مدیر استان ایجاد می‌کند؛ مدیر استان مدیران شهرستانِ زیرمجموعه را می‌سازد.
- مدیران را حذف نکنید؛ آن‌ها را غیرفعال کنید تا سوابق خبر و ممیزی حفظ شود.
- برای reset کردن 2FA مدیر ارشد، از سرور اجرا کنید: `docker exec -w /workspace/PnuNews nodejs node scripts/reset-2fa.js <username>`. کاربر در ورود بعدی دوباره ثبت‌نام می‌کند.

## چک‌لیست تحویل

- [ ] `.autostart` شامل مقدارهای تولیدی است و در Git ثبت نشده است.
- [ ] اتصال SSH و remote مخزن تأیید شده‌اند؛ کلید سرور در صورت خصوصی‌بودن repo فقط دسترسی خواندن دارد.
- [ ] مسیر `/healthz` پاسخ می‌دهد و proxy/TLS به `nodejs:3010` وصل است؛ Authelia غیرفعال است.
- [ ] ورود مدیر، ثبت 2FA، picker استان→شهر، انتشار خبر، رادیو خاموش/روشن و دانلود پیوست دستی بررسی شده‌اند.
- [ ] پشتیبان دیتابیس و `uploads/` گرفته و محل نگهداری امن آن‌ها مشخص شده است.
- [ ] نسخهٔ پشتیبان، راهنمای بازیابی و زمان‌بندی backup دوره‌ای با مالک توافق شده‌اند.
