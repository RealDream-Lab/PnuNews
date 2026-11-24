-- ورود خواننده با «پیامکی که خودش می‌فرستد» (روش sms_receive): خواننده از سیم‌کارت خودش به خط دریافت ما پیامک می‌فرستد و ippanel آن را با GET به سرور ما می‌رساند.
-- فقط هش کد (HMAC با راز برنامه روی شماره و کد) و هش دستگیرهٔ مرورگر نگه داشته می‌شود؛ نه کد و نه دستگیره هرگز ساده ذخیره نمی‌شوند.
CREATE TABLE IF NOT EXISTS reader_inbound_challenges (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(16) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  handle_hash CHAR(64) NOT NULL,
  ip VARCHAR(45) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  confirmed_at DATETIME NULL,
  consumed_at DATETIME NULL,
  UNIQUE KEY uq_reader_inbound_handle (handle_hash),
  KEY idx_reader_inbound_phone_expiry (phone, expires_at),
  KEY idx_reader_inbound_phone_time (phone, created_at),
  KEY idx_reader_inbound_ip_time (ip, created_at),
  KEY idx_reader_inbound_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- گزارش کوچک پیامک‌های دریافتی برای مدیر ارشد: شمارهٔ ماسک‌شده و کد دلیل؛ هرگز متن پیام، کد، کلید یا شمارهٔ کامل.
CREATE TABLE IF NOT EXISTS reader_inbound_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  masked_phone VARCHAR(16) NULL,
  ip VARCHAR(45) NULL,
  outcome VARCHAR(12) NOT NULL,
  reason VARCHAR(20) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_reader_inbound_log_time (created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
