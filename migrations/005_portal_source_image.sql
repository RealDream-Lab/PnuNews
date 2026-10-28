-- Portal news keep the address of the original image. Browsers load it directly from pnu.ac.ir because the server cannot reach it reliably.
ALTER TABLE news ADD COLUMN source_image_url TEXT NULL
