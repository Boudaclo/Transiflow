-- Étape 5 : postes (appareils), plages de numéros, synchronisation hors ligne, anomalies.

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('vente', 'controle')),
  public_key text NOT NULL,
  status text NOT NULL DEFAULT 'en_attente' CHECK (status IN ('en_attente', 'actif', 'revoque')),
  signing_key_id uuid,
  requested_by uuid NOT NULL REFERENCES users(id),
  activated_by uuid REFERENCES users(id),
  activated_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  revoke_reason text,
  last_seen_at timestamptz,
  clock_offset_ms bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, signing_key_id) REFERENCES signing_keys (tenant_id, id),
  CHECK (status <> 'revoque' OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, public_key)
);

-- Plages de numéros réservées par poste (prélevées sur le même compteur que les ventes en ligne : jamais de chevauchement)
CREATE TABLE number_ranges (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  start_number integer NOT NULL CHECK (start_number >= 1),
  end_number integer NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id),
  CHECK (end_number >= start_number)
);
CREATE INDEX number_ranges_device_idx ON number_ranges (device_id);

CREATE TABLE anomalies (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL,
  device_id uuid,
  ticket_id uuid,
  trip_id uuid,
  detail jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'ouverte' CHECK (status IN ('ouverte', 'traitee')),
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_by uuid REFERENCES users(id),
  handled_at timestamptz,
  note text
);
CREATE INDEX anomalies_tenant_idx ON anomalies (tenant_id, status, created_at DESC);

ALTER TABLE tickets
  ADD COLUMN device_id uuid,
  ADD COLUMN offline boolean NOT NULL DEFAULT false,
  ADD COLUMN synced_at timestamptz,
  ADD FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id);

CREATE OR REPLACE FUNCTION tickets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.number <> OLD.number OR NEW.line_id <> OLD.line_id
     OR NEW.trip_id <> OLD.trip_id OR NEW.from_stop_id <> OLD.from_stop_id OR NEW.to_stop_id <> OLD.to_stop_id
     OR NEW.category <> OLD.category OR NEW.seats <> OLD.seats OR NEW.unit_price_xof <> OLD.unit_price_xof
     OR NEW.total_xof <> OLD.total_xof OR NEW.qr <> OLD.qr OR NEW.signing_key_id <> OLD.signing_key_id
     OR NEW.sold_by <> OLD.sold_by OR NEW.sold_at <> OLD.sold_at OR NEW.offline <> OLD.offline
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION 'un billet vendu est immuable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'vendu' AND NEW.status IN ('valide', 'annule')) THEN
    RAISE EXCEPTION 'changement de statut de billet interdit : % vers %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

-- Journal des présentations : champs de synchronisation hors ligne
ALTER TABLE validations
  ADD COLUMN device_id uuid,
  ADD COLUMN client_ref uuid,
  ADD COLUMN claimed_ticket_id uuid,
  ADD COLUMN scanned_at_device timestamptz,
  ADD COLUMN scanned_at_corrected timestamptz,
  ADD COLUMN local_result text,
  ADD FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id);
CREATE UNIQUE INDEX validations_client_ref_unique ON validations (tenant_id, device_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX validations_pending_idx ON validations (tenant_id, claimed_ticket_id) WHERE result = 'en_attente';

-- Un paiement mobile saisi hors ligne est « à vérifier » : sa référence peut être en double (signalée en anomalie)
DROP INDEX payments_reference_unique;
CREATE UNIQUE INDEX payments_reference_unique ON payments (tenant_id, method, reference)
  WHERE reference IS NOT NULL AND status <> 'a_verifier';

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE number_ranges ENABLE ROW LEVEL SECURITY;
ALTER TABLE anomalies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON devices USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());
CREATE POLICY tenant_isolation ON number_ranges USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());
CREATE POLICY tenant_isolation ON anomalies USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());

GRANT SELECT, INSERT, UPDATE ON devices TO transport_app;
GRANT SELECT, INSERT ON number_ranges, anomalies TO transport_app;
GRANT UPDATE (status, handled_by, handled_at, note) ON anomalies TO transport_app;
GRANT UPDATE (ticket_id, result) ON validations TO transport_app;
GRANT USAGE ON SEQUENCE number_ranges_id_seq, anomalies_id_seq TO transport_app;

-- Révocation d'un poste : seule la colonne de statut de sa clé peut changer (jamais la clé elle-même)
GRANT UPDATE (status, revoked_at) ON signing_keys TO transport_app;
