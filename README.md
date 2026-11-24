# اخبار پیام نور

وب‌سایت خبری فارسی و راست‌چین پیام نور؛ ساخته‌شده با Node.js 24، Express و MariaDB 12.3. همهٔ وابستگی‌های زمان اجرا از طریق برنامه ارائه می‌شوند و رابط کاربری برای اجرا به CDN نیاز ندارد.

## توسعهٔ محلی

پیش‌نیازها: Node.js نسخهٔ 24 یا بالاتر و Docker Desktop.

```sh
cp .env.dev.example .env.dev
# مقادیر توسعه را در .env.dev بازبینی کنید.
docker compose -f docker-compose.dev.yml up -d
npm install
npm run migrate
npm run seed
npm run create-admin
npm run dev
```

`npm run create-admin` تعاملی است و گذرواژه را هنگام تایپ نمایش نمی‌دهد. سرویس محلی در `http://localhost:3010` و پنل مدیریت در `/dashboard` در دسترس است.

## استقرار

راهنمای کامل آماده‌سازی سرور، نصب وابستگی‌ها، استقرار از شاخهٔ `main` یا `deploy`، پشتیبان‌گیری و بازیابی در [`docs/OPERATIONS.md`](docs/OPERATIONS.md) است. تنظیمات محرمانه فقط در `.autostart` روی سرور نگهداری می‌شوند؛ هرگز این فایل، `.env.dev`، `uploads/` یا `node_modules/` را به `main` اضافه نکنید.

## حساب خوانندگان

خواننده‌ها می‌توانند بدون ثبت‌نام همه‌چیز را بخوانند و خبرها را در همان دستگاه نشانک کنند. اگر مدیر ارشد «ثبت‌نام و ورود خوانندگان» را از پنل روشن کند، با شمارهٔ موبایل و کد پیامکی (ippanel) حساب می‌سازند و نشانک‌هایشان بین دستگاه‌ها همگام می‌شود. کلید و پترن ippanel در `.autostart` می‌روند؛ راه‌اندازی، بودجهٔ پیامک، حریم خصوصی و عیب‌یابی در [`docs/OPERATIONS.md`](docs/OPERATIONS.md) و چک‌لیست دستی در [`docs/QA-READER-ACCOUNTS.md`](docs/QA-READER-ACCOUNTS.md) است.

مدیر ارشد می‌تواند به‌جای «کد پیامکیِ ارسالی از طرف ما» روش دوم را انتخاب کند: خواننده خودش از سیم‌کارتش پیامک کوتاهی به خط دریافت می‌فرستد و ippanel آن را با وب‌هوک به سرور می‌رساند (بدون هزینه برای هر ورود). راه‌اندازی، آزمایش و کدهای دلیل در [`docs/INBOUND-SMS-LOGIN.md`](docs/INBOUND-SMS-LOGIN.md) است.

## مستندات

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): ساختار و معماری
- [`docs/DECISIONS.md`](docs/DECISIONS.md): تصمیم‌های فنی
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md): راهنمای اجرا و نگهداری
- [`docs/PROGRESS.md`](docs/PROGRESS.md): milestoneها و کارهای باقی‌مانده
- [`docs/QA-READER-ACCOUNTS.md`](docs/QA-READER-ACCOUNTS.md): چک‌لیست دستی حساب خوانندگان
- [`docs/INBOUND-SMS-LOGIN.md`](docs/INBOUND-SMS-LOGIN.md): ورود با پیامکِ ارسالی از طرف خواننده (وب‌هوک ippanel)
