-- حوزه‌های کاری (آموزش، فرهنگی و دانشجویی، …): مدیر ارشد تعریف می‌کند و مدیر هر واحد برای واحد خودش کاربر حوزه می‌سازد.
CREATE TABLE IF NOT EXISTS work_domains (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_work_domains_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO work_domains (name, sort_order) VALUES ('آموزش', 1), ('فرهنگی و دانشجویی', 2), ('دایره کلاس‌ها', 3), ('امتحانات', 4), ('شهریه', 5), ('روابط عمومی', 6);
ALTER TABLE users MODIFY role ENUM('super_admin','country_admin','province_admin','city_admin','domain_user') NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS domain_id BIGINT UNSIGNED NULL AFTER region_id;
ALTER TABLE users ADD KEY IF NOT EXISTS idx_users_region_domain (region_id, domain_id, is_active);
ALTER TABLE users ADD CONSTRAINT fk_users_domain FOREIGN KEY IF NOT EXISTS (domain_id) REFERENCES work_domains(id) ON DELETE RESTRICT;
-- دو تنظیم قدیمی با نقش‌های حوزه بی‌معنی شدند: سقف تعداد مدیر هر واحد (حالا همیشه یک مدیر فعال) و ویرایش خبر همکار هم‌سطح.
DELETE FROM settings WHERE k IN ('max_city_admins', 'peer_edit_enabled')
