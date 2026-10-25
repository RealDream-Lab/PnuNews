# راهنمای عملیات

## توسعهٔ محلی

1. Node.js نسخهٔ 24 یا بالاتر و Docker Desktop را نصب کنید.
2. فایل `.env.dev.example` را به `.env.dev` کپی کنید.
3. `docker compose -f docker-compose.dev.yml up -d` را اجرا کنید.
4. `npm install`، سپس `npm run migrate` و `npm run dev` را اجرا کنید.

## تولید

مقادیر محرمانه فقط در `.autostart` قرار می‌گیرند؛ آن را در مخزن ثبت نکنید. مقدار `APP_SECRET` را با `openssl rand -hex 32` بسازید. دستورهای استقرار، پشتیبان‌گیری و بازیابی در milestoneهای استقرار تکمیل می‌شوند.
