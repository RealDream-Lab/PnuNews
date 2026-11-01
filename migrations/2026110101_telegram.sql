-- ارسال خبرها به کانال تلگرام: اتصال هر کاربر (ربات و کانال) و صف/وضعیت پیام‌ها.
CREATE TABLE IF NOT EXISTS telegram_channels (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  bot_token_enc TEXT NOT NULL,
  bot_username VARCHAR(80) NULL,
  chat_ref VARCHAR(80) NOT NULL,
  chat_id VARCHAR(40) NOT NULL,
  chat_title VARCHAR(200) NULL,
  fail_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(300) NULL,
  last_sent_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_telegram_channels_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS telegram_posts (
  news_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  chat_id VARCHAR(40) NOT NULL,
  message_id BIGINT NULL,
  state ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
  needs_update TINYINT(1) NOT NULL DEFAULT 0,
  text_hash CHAR(64) NULL,
  cover_key VARCHAR(120) NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error VARCHAR(300) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (news_id, user_id),
  KEY idx_telegram_posts_queue (state, needs_update, next_attempt_at),
  KEY idx_telegram_posts_chat (news_id, chat_id),
  KEY idx_telegram_posts_user (user_id, updated_at),
  CONSTRAINT fk_telegram_posts_news FOREIGN KEY (news_id) REFERENCES news(id) ON DELETE CASCADE,
  CONSTRAINT fk_telegram_posts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
