-- Automatic import of the university portal news: remember the source link (unique) and mark the bot user as a system user.
ALTER TABLE users ADD COLUMN is_system TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE news ADD COLUMN source_url VARCHAR(400) NULL, ADD UNIQUE KEY uq_news_source_url (source_url)
