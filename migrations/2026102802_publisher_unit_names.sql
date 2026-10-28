-- امضای خبرهای قبلی: «روابط عمومی مرکز دانشگاهی X» -> «دانشگاه پیام نور X» و «روابط عمومی استان X» -> «دانشگاه پیام نور استان X».
UPDATE news SET updated_at = updated_at, publisher_unit = REPLACE(publisher_unit, 'روابط عمومی مرکز دانشگاهی ', 'دانشگاه پیام نور ') WHERE publisher_unit LIKE 'روابط عمومی مرکز دانشگاهی %';
UPDATE news SET updated_at = updated_at, publisher_unit = REPLACE(publisher_unit, 'روابط عمومی استان ', 'دانشگاه پیام نور استان ') WHERE publisher_unit LIKE 'روابط عمومی استان %'
