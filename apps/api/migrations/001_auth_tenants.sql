-- Rôle applicatif : soumis à la RLS (ni propriétaire des tables, ni BYPASSRLS).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'transport_app') THEN
    CREATE ROLE transport_app NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO transport_app;

-- Contexte de requête posé par l'API (set_config local à la transaction)
CREATE FUNCTION app_current_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app_is_platform() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.is_platform', true), '') = 'on' $$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  currency text NOT NULL DEFAULT 'XOF',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (code text PRIMARY KEY, label text NOT NULL);
INSERT INTO roles (code, label) VALUES
  ('super_admin', 'Super-administrateur plateforme'), ('directeur', 'Directeur / administrateur compagnie'),
  ('caissier', 'Caissier'), ('controleur', 'Contrôleur'), ('exploitation', 'Responsable d''exploitation'),
  ('flotte', 'Responsable de flotte'), ('comptable', 'Comptable'), ('chauffeur', 'Chauffeur');

-- tenant_id NULL = compte plateforme (super-admin uniquement)
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id),
  email text NOT NULL CHECK (email = lower(email)),
  full_name text NOT NULL,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (email);
CREATE INDEX users_tenant_idx ON users (tenant_id);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code text NOT NULL REFERENCES roles(code),
  PRIMARY KEY (user_id, role_code)
);

CREATE FUNCTION enforce_role_scope() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE t uuid;
BEGIN
  SELECT tenant_id INTO t FROM users WHERE id = NEW.user_id;
  IF NEW.role_code = 'super_admin' AND t IS NOT NULL THEN
    RAISE EXCEPTION 'le rôle super_admin est réservé aux comptes plateforme';
  END IF;
  IF NEW.role_code <> 'super_admin' AND t IS NULL THEN
    RAISE EXCEPTION 'un compte plateforme ne peut avoir que le rôle super_admin';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_roles_scope BEFORE INSERT OR UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION enforce_role_scope();

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES tenants(id),
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  user_id uuid,
  action text NOT NULL,
  object_type text,
  object_id text,
  before jsonb,
  after jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_idx ON audit_logs (tenant_id, created_at DESC);

-- Journal immuable : ni UPDATE ni DELETE, même pour le propriétaire
CREATE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'audit_logs est immuable'; END $$;
CREATE TRIGGER audit_logs_no_change BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- Row-Level Security : seconde barrière derrière le filtrage applicatif
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant() OR app_is_platform())
  WITH CHECK (id = app_current_tenant() OR app_is_platform());
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());
CREATE POLICY tenant_isolation ON user_roles
  USING (app_is_platform() OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_roles.user_id AND u.tenant_id = app_current_tenant()))
  WITH CHECK (app_is_platform() OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_roles.user_id AND u.tenant_id = app_current_tenant()));
CREATE POLICY tenant_isolation ON refresh_tokens
  USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());
CREATE POLICY tenant_isolation ON audit_logs
  USING (tenant_id = app_current_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform());

GRANT SELECT, INSERT, UPDATE ON tenants TO transport_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, user_roles, refresh_tokens TO transport_app;
GRANT SELECT ON roles TO transport_app;
GRANT SELECT, INSERT ON audit_logs TO transport_app;
GRANT USAGE ON SEQUENCE audit_logs_id_seq TO transport_app;

-- Seules brèches contrôlées dans la RLS : recherches avant que la compagnie soit connue
CREATE FUNCTION auth_find_user_by_email(p_email text)
RETURNS TABLE (id uuid, tenant_id uuid, email text, full_name text, password_hash text, active boolean,
               failed_attempts integer, locked_until timestamptz, tenant_active boolean, roles text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.tenant_id, u.email, u.full_name, u.password_hash, u.active, u.failed_attempts, u.locked_until,
         coalesce(t.active, true),
         array(SELECT ur.role_code FROM user_roles ur WHERE ur.user_id = u.id ORDER BY ur.role_code)
  FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
  WHERE u.email = lower(p_email)
$$;
CREATE FUNCTION auth_find_refresh_token(p_id uuid)
RETURNS TABLE (id uuid, family_id uuid, user_id uuid, tenant_id uuid, token_hash text,
               expires_at timestamptz, used_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.family_id, r.user_id, r.tenant_id, r.token_hash, r.expires_at, r.used_at, r.revoked_at
  FROM refresh_tokens r WHERE r.id = p_id
$$;
REVOKE ALL ON FUNCTION auth_find_user_by_email(text), auth_find_refresh_token(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user_by_email(text), auth_find_refresh_token(uuid) TO transport_app;
