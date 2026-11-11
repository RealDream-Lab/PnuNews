-- The portal returned the same article with different letter case in the link (DouranPortal / douranportal), so it was imported twice. Keep the oldest copy, hide the later ones and re-key every portal news by its lower-cased link.
UPDATE news d JOIN news k ON k.source_url IS NOT NULL AND k.deleted_at IS NULL AND k.id < d.id AND LOWER(k.source_url) = LOWER(d.source_url) SET d.deleted_at = UTC_TIMESTAMP(), d.source_hash = NULL WHERE d.source_url IS NOT NULL AND d.deleted_at IS NULL;
UPDATE news SET source_hash = SHA2(LOWER(source_url), 256) WHERE source_url IS NOT NULL AND deleted_at IS NULL
