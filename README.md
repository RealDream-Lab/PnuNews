# اخبار پیام نور

برنامهٔ خبری فارسی و راست‌چین برای پیام نور؛ توسعهٔ محلی با Node.js 24 و MariaDB 12.3 انجام می‌شود.

## شروع توسعه

```sh
cp .env.dev.example .env.dev
docker compose -f docker-compose.dev.yml up -d
npm install
npm run migrate
npm run dev
```

سرویس محلی روی `http://localhost:3010` در دسترس است. راهنمای عملیات در `docs/OPERATIONS.md` و تصمیم‌های پروژه در `docs/DECISIONS.md` قرار دارد.
