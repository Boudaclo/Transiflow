import { Pool } from 'pg';
import { runMigrations } from '../src/database/migrate';
import { adminPool, appPool, uid } from './helpers';

describe('Base de données : migrations, RLS, journal immuable', () => {
  let admin: Pool;
  let app: Pool;
  let A: string;
  let B: string;
  const withCtx = async (settings: Record<string, string>, sql: string, params: unknown[] = []) => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      for (const [k, v] of Object.entries(settings)) await c.query('SELECT set_config($1,$2,true)', [k, v]);
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    admin = adminPool();
    app = appPool();
    const mk = async (slug: string) => (await admin.query('INSERT INTO tenants (name, slug) VALUES ($1,$1) RETURNING id', [slug])).rows[0].id as string;
    A = await mk(`rls-a-${uid()}`);
    B = await mk(`rls-b-${uid()}`);
    for (const [t, n] of [[A, 'a'], [B, 'b']]) {
      await admin.query('INSERT INTO users (tenant_id,email,full_name,password_hash) VALUES ($1,$2,$3,$4)', [t, `${n}-${uid()}@rls.test`, n, 'x']);
      await admin.query('INSERT INTO audit_logs (tenant_id, action) VALUES ($1, $2)', [t, 'test.event']);
    }
  });
  afterAll(async () => { await admin.end(); await app.end(); });

  it('rejoue les migrations sans effet (idempotent)', async () => {
    expect(await runMigrations(process.env.DATABASE_ADMIN_URL!)).toEqual([]);
  });

  it('un contexte compagnie ne voit que ses lignes, même sans WHERE', async () => {
    const users = await withCtx({ 'app.tenant_id': A }, 'SELECT tenant_id FROM users');
    expect(users.rows.length).toBeGreaterThan(0);
    expect(users.rows.every((r) => r.tenant_id === A)).toBe(true);
    const tenants = await withCtx({ 'app.tenant_id': A }, 'SELECT id FROM tenants');
    expect(tenants.rows.map((r) => r.id)).toEqual([A]);
    const audit = await withCtx({ 'app.tenant_id': B }, 'SELECT tenant_id FROM audit_logs');
    expect(audit.rows.every((r) => r.tenant_id === B)).toBe(true);
  });

  it('sans contexte, aucune donnée n\'est visible', async () => {
    for (const table of ['tenants', 'users', 'user_roles', 'refresh_tokens', 'audit_logs']) {
      expect((await app.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
    }
  });

  it('refuse d\'écrire dans une autre compagnie', async () => {
    await expect(
      withCtx({ 'app.tenant_id': A }, 'INSERT INTO users (tenant_id,email,full_name,password_hash) VALUES ($1,$2,$3,$4)', [B, `x-${uid()}@rls.test`, 'x', 'x']),
    ).rejects.toThrow(/row-level security/);
    const upd = await withCtx({ 'app.tenant_id': A }, 'UPDATE users SET full_name = $1 WHERE tenant_id = $2', ['piraté', B]);
    expect(upd.rowCount).toBe(0);
    const del = await withCtx({ 'app.tenant_id': A }, 'DELETE FROM users WHERE tenant_id = $1', [B]);
    expect(del.rowCount).toBe(0);
  });

  it('le contexte plateforme voit toutes les compagnies', async () => {
    const r = await withCtx({ 'app.is_platform': 'on' }, 'SELECT id FROM tenants WHERE id = ANY($1)', [[A, B]]);
    expect(r.rowCount).toBe(2);
  });

  it('le journal d\'audit est immuable (application ET propriétaire)', async () => {
    await expect(withCtx({ 'app.tenant_id': A }, "UPDATE audit_logs SET action = 'x'")).rejects.toThrow();
    await expect(withCtx({ 'app.tenant_id': A }, 'DELETE FROM audit_logs')).rejects.toThrow();
    await expect(admin.query("UPDATE audit_logs SET action = 'x'")).rejects.toThrow(/immuable/);
    await expect(admin.query('DELETE FROM audit_logs')).rejects.toThrow(/immuable/);
  });

  it('un compte plateforme ne peut avoir que le rôle super_admin (et inversement)', async () => {
    const u = (await admin.query("INSERT INTO users (tenant_id,email,full_name,password_hash) VALUES (NULL,$1,'p','x') RETURNING id", [`p-${uid()}@rls.test`])).rows[0].id;
    await expect(admin.query("INSERT INTO user_roles (user_id, role_code) VALUES ($1,'caissier')", [u])).rejects.toThrow(/plateforme/);
    const t = (await admin.query("INSERT INTO users (tenant_id,email,full_name,password_hash) VALUES ($1,$2,'t','x') RETURNING id", [A, `t-${uid()}@rls.test`])).rows[0].id;
    await expect(admin.query("INSERT INTO user_roles (user_id, role_code) VALUES ($1,'super_admin')", [t])).rejects.toThrow(/réservé/);
  });
});
