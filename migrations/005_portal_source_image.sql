-- Portal news keep the address of the original image; browsers load it directly from pnu.ac.ir (the server cannot reach it reliably).
ALTER TABLE news ADD COLUMN source_image_url TEXT NULL
