-- Portal links with Persian slugs can be very long: keep the full link in a TEXT column and de-duplicate by its SHA-256 hash.
ALTER TABLE news DROP INDEX uq_news_source_url, MODIFY source_url TEXT NULL, ADD COLUMN source_hash CHAR(64) NULL, ADD UNIQUE KEY uq_news_source_hash (source_hash)
