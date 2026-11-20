-- حساب خوانندگان (مرحلهٔ ۲): سامانه‌ای جدا از کاربران مدیریتی (users)؛ ورود با کد پیامکی، نشانک خبرها روی سرور و گزارش پیامک‌ها.
-- شمارهٔ موبایل با قالب E.164 (+98...) ذخیره می‌شود و پس از ثبت‌نام تغییر نمی‌کند. شمارهٔ دانشجویی را کاربر خودش اعلام می‌کند (تأییدنشده) و در کل سامانه یکتاست.
CREATE TABLE IF NOT EXISTS reader_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(16) NOT NULL,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  is_student TINYINT(1) NOT NULL DEFAULT 0,
  student_no VARCHAR(20) NULL,
  unit_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME NULL,
  UNIQUE KEY uq_reader_phone (phone),
  UNIQUE KEY uq_reader_student_no (student_no),
  KEY idx_reader_unit (unit_id),
  KEY idx_reader_created (created_at, id),
  CONSTRAINT fk_reader_unit FOREIGN KEY (unit_id) REFERENCES regions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- نشست خواننده: فقط هش توکن نگه داشته می‌شود (خود توکن در کوکی است).
CREATE TABLE IF NOT EXISTS reader_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reader_session_token (token_hash),
  KEY idx_reader_session_user (user_id),
  KEY idx_reader_session_expiry (expires_at),
  CONSTRAINT fk_reader_session_user FOREIGN KEY (user_id) REFERENCES reader_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- کد یکبارمصرف پیامکی: فقط هش کد، با انقضا و شمارندهٔ تلاش؛ ip برای سقف درخواست در هر ساعت.
CREATE TABLE IF NOT EXISTS reader_otps (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(16) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  ip VARCHAR(45) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_reader_otp_phone_time (phone, created_at),
  KEY idx_reader_otp_ip_time (ip, created_at),
  KEY idx_reader_otp_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- نشانک‌های خواننده. زمان‌ها میلی‌ثانیهٔ یونیکس هستند (همان مقداری که مرورگر می‌سازد) تا مقایسهٔ «آخرین تغییر برنده است» دقیق بماند؛ حذف با deleted_at (علامت حذف) ثبت می‌شود.
-- با حذف خبر یا حساب، نشانک هم خودبه‌خود پاک می‌شود.
CREATE TABLE IF NOT EXISTS reader_bookmarks (
  user_id BIGINT UNSIGNED NOT NULL,
  news_id BIGINT UNSIGNED NOT NULL,
  saved_at BIGINT UNSIGNED NOT NULL,
  deleted_at BIGINT UNSIGNED NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, news_id),
  KEY idx_reader_bookmark_news (news_id),
  CONSTRAINT fk_reader_bookmark_user FOREIGN KEY (user_id) REFERENCES reader_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_reader_bookmark_news FOREIGN KEY (news_id) REFERENCES news(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- گزارش ارسال پیامک: شمارهٔ ماسک‌شده (بدون متن پیام و بدون کد)، نتیجه و کد پاسخ ippanel؛ برای سقف روزانه، خاموشی خودکار و نمایش خطاها به مدیر ارشد.
CREATE TABLE IF NOT EXISTS sms_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  masked_phone VARCHAR(16) NOT NULL,
  ip VARCHAR(45) NULL,
  ok TINYINT(1) NOT NULL,
  message_code VARCHAR(20) NULL,
  outbox_id VARCHAR(40) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sms_log_time (created_at, id),
  KEY idx_sms_log_ok_time (ok, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
