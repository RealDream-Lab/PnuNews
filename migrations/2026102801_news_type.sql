-- نوع مطلب: خبر یا اطلاعیه (پیش‌فرض: خبر). برای ردیف‌های قبلی هم «خبر» ثبت می‌شود.
ALTER TABLE news ADD COLUMN IF NOT EXISTS news_type ENUM('news','announcement') NOT NULL DEFAULT 'news' AFTER category_id;
