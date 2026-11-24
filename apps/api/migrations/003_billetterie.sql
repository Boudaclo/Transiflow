-- Étape 4 : billetterie en ligne (tickets, paiements, clés de signature, journal des validations).

ALTER TABLE clients ADD CONSTRAINT clients_tenant_id_key UNIQUE (tenant_id, id);
ALTER TABLE trips ADD CONSTRAINT trips_id_line_key UNIQUE (id, line_id);

-- Clés de signature des QR. kind 'serveur' : clé privée chiffrée en base (vente en ligne).
-- kind 'poste' : clé générée sur l'appareil, seule la clé publique est connue (étape 5).
CREATE TABLE signing_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('serveur', 'poste')),
  public_key text NOT NULL,
  private_key_enc text,
  status text NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'revoque')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK ((kind = 'serveur') = (private_key_enc IS NOT NULL)),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX signing_keys_one_active_server ON signing_keys (tenant_id) WHERE kind = 'serveur' AND status = 'actif';

-- Numérotation par compagnie. Les plages réservées par les postes hors ligne (étape 5) s'en serviront aussi.
CREATE TABLE ticket_counters (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  next_number integer NOT NULL DEFAULT 1 CHECK (next_number >= 1)
);

CREATE TABLE tickets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  number integer NOT NULL CHECK (number >= 1),
  line_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  from_stop_id uuid NOT NULL,
  to_stop_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('plein_tarif', 'enfant', 'etudiant')),
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 10),
  unit_price_xof integer NOT NULL CHECK (unit_price_xof > 0),
  total_xof integer NOT NULL CHECK (total_xof > 0),
  client_id uuid,
  status text NOT NULL DEFAULT 'vendu' CHECK (status IN ('vendu', 'valide', 'annule')),
  signing_key_id uuid NOT NULL,
  qr text NOT NULL,
  sold_by uuid NOT NULL REFERENCES users(id),
  sold_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz,
  validated_by uuid REFERENCES users(id),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES users(id),
  cancel_reason text,
  FOREIGN KEY (tenant_id, line_id) REFERENCES lines (tenant_id, id),
  FOREIGN KEY (trip_id, line_id) REFERENCES trips (id, line_id),
  FOREIGN KEY (line_id, from_stop_id) REFERENCES stops (line_id, id),
  FOREIGN KEY (line_id, to_stop_id) REFERENCES stops (line_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id),
  FOREIGN KEY (tenant_id, signing_key_id) REFERENCES signing_keys (tenant_id, id),
  CHECK (total_xof = unit_price_xof * seats),
  CHECK (status <> 'annule' OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  CHECK (status <> 'valide' OR validated_at IS NOT NULL),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id)
);
CREATE INDEX tickets_trip_idx ON tickets (trip_id, status);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('especes', 'orange_money', 'moov_money')),
  amount_xof integer NOT NULL CHECK (amount_xof > 0),
  reference text,
  status text NOT NULL DEFAULT 'encaisse' CHECK (status IN ('encaisse', 'a_verifier', 'rembourse')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id),
  CHECK (method = 'especes' OR reference IS NOT NULL)
);
CREATE UNIQUE INDEX payments_ticket_unique ON payments (ticket_id);
-- Une même référence de transaction mobile ne peut payer qu'un seul billet
CREATE UNIQUE INDEX payments_reference_unique ON payments (tenant_id, method, reference) WHERE reference IS NOT NULL;

-- Journal de toutes les présentations de billet au contrôle (valides ou refusées)
CREATE TABLE validations (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  ticket_id uuid,
  trip_id uuid,
  user_id uuid NOT NULL REFERENCES users(id),
  result text NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id)
);
CREATE INDEX validations_ticket_idx ON validations (ticket_id);

-- Un billet vendu ne se modifie jamais, sauf son statut (vendu → validé ou annulé) et les champs associés
CREATE FUNCTION tickets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.number <> OLD.number OR NEW.line_id <> OLD.line_id
     OR NEW.trip_id <> OLD.trip_id OR NEW.from_stop_id <> OLD.from_stop_id OR NEW.to_stop_id <> OLD.to_stop_id
     OR NEW.category <> OLD.category OR NEW.seats <> OLD.seats OR NEW.unit_price_xof <> OLD.unit_price_xof
     OR NEW.total_xof <> OLD.total_xof OR NEW.qr <> OLD.qr OR NEW.signing_key_id <> OLD.signing_key_id
     OR NEW.sold_by <> OLD.sold_by OR NEW.sold_at <> OLD.sold_at
     OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION 'un billet vendu est immuable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'vendu' AND NEW.status IN ('valide', 'annule')) THEN
    RAISE EXCEPTION 'changement de statut de billet interdit : % vers %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tickets_immutable BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION tickets_guard();

ALTER TABLE signing_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE validations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON signing_keys USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());
CREATE POLICY tenant_isolation ON ticket_counters USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());
CREATE POLICY tenant_isolation ON tickets USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());
CREATE POLICY tenant_isolation ON payments USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());
CREATE POLICY tenant_isolation ON validations USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());

GRANT SELECT, INSERT ON signing_keys, validations TO transport_app;
GRANT SELECT, INSERT, UPDATE ON ticket_counters, tickets, payments TO transport_app;
GRANT USAGE ON SEQUENCE validations_id_seq TO transport_app;
