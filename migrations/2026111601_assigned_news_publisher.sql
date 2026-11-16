-- خبرهای منتشرشده‌ای که پیش‌تر به کاربر دیگر اختصاص داده شده‌اند: نام و واحد منتشرکننده (که در صفحهٔ اول و صفحهٔ خبر دیده می‌شود) را با نویسندهٔ فعلی خبر هم‌سو کن.
UPDATE news n
  JOIN users u ON u.id = n.created_by
  JOIN regions r ON r.id = n.origin_region_id
  SET n.updated_at = n.updated_at,
      n.published_by_user_id = u.id,
      n.publisher_name = u.full_name,
      n.publisher_unit = CASE
        WHEN r.type = 'country' THEN IF(u.role IN ('country_admin', 'domain_user'), 'روابط عمومی سازمان مرکزی', 'روابط عمومی کل کشور')
        WHEN r.type = 'province' THEN CONCAT('دانشگاه پیام نور استان ', r.name)
        ELSE CONCAT('دانشگاه پیام نور ', r.name)
      END
  WHERE n.deleted_at IS NULL
    AND n.published_by_user_id IS NOT NULL
    AND n.source_url IS NULL
    AND n.id IN (SELECT a.entity_id FROM audit_log a WHERE a.entity = 'news' AND a.action = 'news.assign')
