import { Pool } from 'pg';
import { adminPool, appPool, uid } from './helpers';

describe('Base de données étape 3 : RLS et cohérence entre compagnies', () => {
  let admin: Pool;
  let app: Pool;
  const ids: Record<string, string> = {};
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
  const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;

  beforeAll(async () => {
    admin = adminPool();
    app = appPool();
    for (const k of ['A', 'B']) {
      const t = await one('INSERT INTO tenants (name, slug) VALUES ($1,$1) RETURNING id', [`r3-${k.toLowerCase()}-${uid()}`]);
      const l = await one("INSERT INTO lines (tenant_id, code, name) VALUES ($1,'R3','Ligne') RETURNING id", [t]);
      const s1 = await one("INSERT INTO stops (tenant_id, line_id, name, position) VALUES ($1,$2,'Un',1) RETURNING id", [t, l]);
      const s2 = await one("INSERT INTO stops (tenant_id, line_id, name, position) VALUES ($1,$2,'Deux',2) RETURNING id", [t, l]);
      await admin.query('INSERT INTO fares (tenant_id, line_id, from_stop_id, to_stop_id, price_xof) VALUES ($1,$2,$3,$4,5000)', [t, l, s1, s2]);
      await admin.query("INSERT INTO trips (tenant_id, line_id, departure_at, seats) VALUES ($1,$2,now(),50)", [t, l]);
      await admin.query("INSERT INTO clients (tenant_id, full_name, phone) VALUES ($1,'Client','+22670000000')", [t]);
      Object.assign(ids, { [`t${k}`]: t, [`l${k}`]: l, [`s1${k}`]: s1, [`s2${k}`]: s2 });
    }
  });
  afterAll(async () => { await admin.end(); await app.end(); });

  const TABLES = ['clients', 'lines', 'stops', 'fares', 'trips'];

  it('sans contexte, aucune ligne visible', async () => {
    for (const t of TABLES) expect((await app.query(`SELECT 1 FROM ${t}`)).rowCount).toBe(0);
  });
  it('un contexte compagnie ne voit que ses lignes, même sans WHERE', async () => {
    for (const t of TABLES) {
      const r = await withCtx({ 'app.tenant_id': ids.tA! }, `SELECT tenant_id FROM ${t}`);
      expect(r.rowCount).toBeGreaterThan(0);
      expect(r.rows.every((x) => x.tenant_id === ids.tA)).toBe(true);
    }
  });
  it('refuse d\'écrire dans une autre compagnie (RLS)', async () => {
    await expect(withCtx({ 'app.tenant_id': ids.tA! }, "INSERT INTO lines (tenant_id, code, name) VALUES ($1,'HACK','x')", [ids.tB])).rejects.toThrow(/row-level security/);
    await expect(withCtx({ 'app.tenant_id': ids.tA! }, "INSERT INTO clients (tenant_id, full_name, phone) VALUES ($1,'x','+22671111111')", [ids.tB])).rejects.toThrow(/row-level security/);
    expect((await withCtx({ 'app.tenant_id': ids.tA! }, "UPDATE trips SET seats = 1 WHERE tenant_id = $1", [ids.tB])).rowCount).toBe(0);
  });
  it('même avec le contexte plateforme, les clés composites interdisent de mélanger deux compagnies', async () => {
    const P = { 'app.is_platform': 'on' };
    await expect(withCtx(P, "INSERT INTO stops (tenant_id, line_id, name, position) VALUES ($1,$2,'Mélange',9)", [ids.tA, ids.lB])).rejects.toThrow(/foreign key/);
    await expect(withCtx(P, "INSERT INTO trips (tenant_id, line_id, departure_at, seats) VALUES ($1,$2,now() + interval '1 day',10)", [ids.tA, ids.lB])).rejects.toThrow(/foreign key/);
    await expect(withCtx(P, "INSERT INTO fares (tenant_id, line_id, from_stop_id, to_stop_id, price_xof) VALUES ($1,$2,$3,$4,100)", [ids.tA, ids.lA, ids.s1A, ids.s2B])).rejects.toThrow(/foreign key/);
  });
  it('un tarif doit aller vers un arrêt suivant (déclencheur), et ne peut avoir un prix nul', async () => {
    await expect(admin.query("INSERT INTO fares (tenant_id, line_id, from_stop_id, to_stop_id, category, price_xof) VALUES ($1,$2,$3,$4,'enfant',100)", [ids.tA, ids.lA, ids.s2A, ids.s1A])).rejects.toThrow(/arrêt suivant/);
    await expect(admin.query("INSERT INTO fares (tenant_id, line_id, from_stop_id, to_stop_id, category, price_xof) VALUES ($1,$2,$3,$4,'enfant',0)", [ids.tA, ids.lA, ids.s1A, ids.s2A])).rejects.toThrow(/check/);
  });
  it('l\'utilisateur applicatif ne peut pas supprimer lignes, tarifs, départs ni clients', async () => {
    for (const t of ['lines', 'fares', 'trips', 'clients']) {
      await expect(withCtx({ 'app.tenant_id': ids.tA! }, `DELETE FROM ${t}`)).rejects.toThrow(/permission denied/);
    }
  });
});
