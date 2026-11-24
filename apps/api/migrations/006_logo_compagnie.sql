-- Étape 7 : logo de la compagnie (petite image en data URL, redimensionnée par le navigateur).
ALTER TABLE tenants ADD COLUMN logo text CHECK (logo IS NULL OR (length(logo) <= 60000 AND logo ~ '^data:image/(png|jpeg|webp);base64,'));
