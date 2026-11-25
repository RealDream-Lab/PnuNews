-- کاربران مدیریتی (داشبورد) در صفحهٔ خبر مثل خواننده عمل می‌کنند: برای هر مدیر یک حساب خوانندهٔ پیوندخورده ساخته می‌شود (برای نشانک خبرها)، بدون شمارهٔ موبایل.
-- شمارهٔ موبایل برای این حساب‌ها خالی است (UNIQUE چند مقدار خالی را می‌پذیرد). با حذف مدیر، حساب و نشانک‌هایش هم پاک می‌شود.
ALTER TABLE reader_users MODIFY phone VARCHAR(16) NULL;
ALTER TABLE reader_users ADD COLUMN IF NOT EXISTS staff_user_id BIGINT UNSIGNED NULL;
ALTER TABLE reader_users ADD UNIQUE KEY IF NOT EXISTS uq_reader_staff_user (staff_user_id);
ALTER TABLE reader_users ADD CONSTRAINT fk_reader_staff_user FOREIGN KEY IF NOT EXISTS (staff_user_id) REFERENCES users(id) ON DELETE CASCADE;
