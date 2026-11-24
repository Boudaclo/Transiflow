-- Étape 3 : clients, lignes, arrêts, tarifs, départs.
-- Cohérence entre compagnies garantie deux fois : RLS (tenant_id) + clés étrangères composites.

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  full_name text NOT NULL,
  phone text NOT NULL CHECK (phone ~ '^\+?[0-9]{8,15}$'),
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);
CREATE INDEX clients_name_idx ON clients (tenant_id, lower(full_name));

CREATE TABLE lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,12}$'),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  line_id uuid NOT NULL,
  name text NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  FOREIGN KEY (tenant_id, line_id) REFERENCES lines (tenant_id, id),
  UNIQUE (line_id, id),
  -- différable : permet de décaler les positions en une seule requête
  CONSTRAINT stops_line_position_key UNIQUE (line_id, position) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX stops_line_name_unique ON stops (line_id, lower(name));

CREATE TABLE fares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  line_id uuid NOT NULL,
  from_stop_id uuid NOT NULL,
  to_stop_id uuid NOT NULL,
  category text NOT NULL DEFAULT 'plein_tarif' CHECK (category IN ('plein_tarif', 'enfant', 'etudiant')),
  price_xof integer NOT NULL CHECK (price_xof > 0 AND price_xof <= 1000000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, line_id) REFERENCES lines (tenant_id, id),
  FOREIGN KEY (line_id, from_stop_id) REFERENCES stops (line_id, id),
  FOREIGN KEY (line_id, to_stop_id) REFERENCES stops (line_id, id),
  CHECK (from_stop_id <> to_stop_id),
  UNIQUE (line_id, from_stop_id, to_stop_id, category)
);

-- Défense en profondeur : le départ doit précéder l'arrivée sur la ligne
CREATE FUNCTION enforce_fare_direction() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE pf integer; pt integer;
BEGIN
  SELECT position INTO pf FROM stops WHERE id = NEW.from_stop_id;
  SELECT position INTO pt FROM stops WHERE id = NEW.to_stop_id;
  IF pf IS NULL OR pt IS NULL OR pf >= pt THEN
    RAISE EXCEPTION 'le tarif doit aller d''un arrêt vers un arrêt suivant de la ligne';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fares_direction BEFORE INSERT OR UPDATE OF from_stop_id, to_stop_id ON fares
  FOR EACH ROW EXECUTE FUNCTION enforce_fare_direction();

CREATE TABLE trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  line_id uuid NOT NULL,
  departure_at timestamptz NOT NULL,
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'retarde', 'annule')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, line_id) REFERENCES lines (tenant_id, id),
  UNIQUE (line_id, departure_at),
  UNIQUE (tenant_id, id)
);
CREATE INDEX trips_tenant_departure_idx ON trips (tenant_id, departure_at);

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE fares ENABLE ROW LEVEL SECURITY;
ALTER TABLE trips ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON clients USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());
CREATE POLICY tenant_isolation ON lines USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());
CREATE POLICY tenant_isolation ON stops USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());
CREATE POLICY tenant_isolation ON fares USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());
CREATE POLICY tenant_isolation ON trips USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());

GRANT SELECT, INSERT, UPDATE ON clients, lines, fares, trips TO transport_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON stops TO transport_app;
