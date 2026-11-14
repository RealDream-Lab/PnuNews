-- نشست «به یاد سپاری» (فقط موبایل): تا وقتی کوکی هست معتبر می‌ماند و با هر استفاده تمدید می‌شود.
ALTER TABLE sessions ADD COLUMN remember TINYINT(1) NOT NULL DEFAULT 0 AFTER expires_at;
-- کوکی «دستگاه مورداعتماد» ۳۰ روزه حذف شد؛ 2FA اکنون تنظیم هر کاربر است و در هر ورود پرسیده می‌شود.
DROP TABLE IF EXISTS trusted_devices;
-- هر دستگاه یک نشست: رکوردهای تکراریِ هر کاربر با User-Agent یکسان پاک می‌شوند و جدیدترین می‌ماند.
DELETE s1 FROM sessions s1 JOIN sessions s2
  ON s1.user_id = s2.user_id AND s1.user_agent <=> s2.user_agent
  AND (s1.created_at < s2.created_at OR (s1.created_at = s2.created_at AND s1.token_hash < s2.token_hash));
