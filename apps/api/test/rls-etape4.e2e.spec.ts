import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { adminPool, appPool, uid } from './helpers';

describe('Base de données étape 4 : RLS et cohérence des billets', () => {
  let admin: Pool;
  let app: Pool;
  const d: Record<string, Record<string, string>> = { A: {}, B: {} };
  const ctx = async (settings: Record<string, string>, sql: string, params: unknown[] = []) => {
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
  const one = async (sql: string, p: unknown[]) => (await admin.query(sql, p)).rows[0].id as string;
  const ticketSql = `INSERT INTO tickets (id, tenant_id, number, line_id, trip_id, from_stop_id, to_stop_id, category, seats, unit_price_xof, total_xof, signing_key_id, qr, sold_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,'plein_tarif',$8,1000,$9,$10,'qr',$11)`;

  beforeAll(async () => {
    admin = adminPool();
    app = appPool();
    for (const k of ['A', 'B']) {
      const t = await one('INSERT INTO tenants (name, slug) VALUES ($1,$1) RETURNING id', [`r4-${k.toLowerCase()}-${uid()}`]);
      const u = await one("INSERT INTO users (tenant_id,email,full_name,password_hash) VALUES ($1,$2,'u','x') RETURNING id", [t, `u-${uid()}@r4.test`]);
      const l = await one("INSERT INTO lines (tenant_id, code, name) VALUES ($1,'R4','L') RETURNING id", [t]);
      const s1 = await one("INSERT INTO stops (tenant_id, line_id, name, position) VALUES ($1,$2,'Un',1) RETURNING id", [t, l]);
      const s2 = await one("INSERT INTO stops (tenant_id, line_id, name, position) VALUES ($1,$2,'Deux',2) RETURNING id", [t, l]);
      const tr = await one("INSERT INTO trips (tenant_id, line_id, departure_at, seats) VALUES ($1,$2,now(),50) RETURNING id", [t, l]);
      const key = await one("INSERT INTO signing_keys (tenant_id, kind, public_key, private_key_enc) VALUES ($1,'serveur','pk','enc') RETURNING id", [t]);
      const tk = randomUUID();
      await admin.query(ticketSql, [tk, t, 1, l, tr, s1, s2, 2, 2000, key, u]);
      await admin.query("INSERT INTO payments (tenant_id, ticket_id, method, amount_xof) VALUES ($1,$2,'especes',2000)", [t, tk]);
      await admin.query("INSERT INTO validations (tenant_id, ticket_id, user_id, result) VALUES ($1,$2,$3,'valide')", [t, tk, u]);
      await admin.query('INSERT INTO ticket_counters (tenant_id) VALUES ($1)', [t]);
      d[k] = { t, u, l, s1, s2, tr, key, tk };
    }
  });
  afterAll(async () => { await admin.end(); await app.end(); });

  const TABLES = ['signing_keys', 'ticket_counters', 'tickets', 'payments', 'validations'];

  it('sans contexte, aucune ligne visible', async () => {
    for (const t of TABLES) expect((await app.query(`SELECT 1 FROM ${t}`)).rowCount).toBe(0);
  });
  it('un contexte compagnie ne voit que ses lignes', async () => {
    for (const t of TABLES) {
      const r = await ctx({ 'app.tenant_id': d.A!.t! }, `SELECT tenant_id FROM ${t}`);
      expect(r.rowCount).toBeGreaterThan(0);
      expect(r.rows.every((x) => x.tenant_id === d.A!.t)).toBe(true);
    }
  });
  it('refuse d\'écrire un billet ou une clé dans une autre compagnie (RLS)', async () => {
    const A = d.A!; const B = d.B!;
    await expect(ctx({ 'app.tenant_id': A.t! }, ticketSql, [randomUUID(), B.t, 2, B.l, B.tr, B.s1, B.s2, 1, 1000, B.key, B.u])).rejects.toThrow(/row-level security/);
    await expect(ctx({ 'app.tenant_id': A.t! }, "INSERT INTO signing_keys (tenant_id, kind, public_key, private_key_enc) VALUES ($1,'serveur','k','e')", [B.t])).rejects.toThrow(/row-level security/);
    expect((await ctx({ 'app.tenant_id': A.t! }, "UPDATE tickets SET status = 'annule', cancelled_at = now(), cancel_reason = 'x' WHERE tenant_id = $1", [B.t])).rowCount).toBe(0);
  });
  it('les clés composites interdisent de mélanger départ, arrêts, clé ou client de deux compagnies', async () => {
    const A = d.A!; const B = d.B!;
    const P = { 'app.is_platform': 'on' };
    await expect(ctx(P, ticketSql, [randomUUID(), A.t, 2, A.l, B.tr, A.s1, A.s2, 1, 1000, A.key, A.u])).rejects.toThrow(/foreign key/);
    await expect(ctx(P, ticketSql, [randomUUID(), A.t, 2, A.l, A.tr, A.s1, B.s2, 1, 1000, A.key, A.u])).rejects.toThrow(/foreign key/);
    await expect(ctx(P, ticketSql, [randomUUID(), A.t, 2, A.l, A.tr, A.s1, A.s2, 1, 1000, B.key, A.u])).rejects.toThrow(/foreign key/);
  });
  it('le total doit égaler prix × places ; numéro et paiement uniques', async () => {
    const A = d.A!;
    await expect(admin.query(ticketSql, [randomUUID(), A.t, 3, A.l, A.tr, A.s1, A.s2, 2, 9999, A.key, A.u])).rejects.toThrow(/check/);
    await expect(admin.query(ticketSql, [randomUUID(), A.t, 1, A.l, A.tr, A.s1, A.s2, 1, 1000, A.key, A.u])).rejects.toThrow(/duplicate|unique/);
    await expect(admin.query("INSERT INTO payments (tenant_id, ticket_id, method, amount_xof) VALUES ($1,$2,'especes',2000)", [A.t, A.tk])).rejects.toThrow(/duplicate|unique/);
    await expect(admin.query("INSERT INTO payments (tenant_id, ticket_id, method, amount_xof) VALUES ($1,$2,'orange_money',2000)", [A.t, A.tk])).rejects.toThrow();
  });
  it('un billet annulé exige une justification', async () => {
    await expect(admin.query("UPDATE tickets SET status = 'annule', cancelled_at = now() WHERE id = $1", [d.A!.tk])).rejects.toThrow(/check/);
  });
  it('une seule clé serveur active par compagnie', async () => {
    await expect(admin.query("INSERT INTO signing_keys (tenant_id, kind, public_key, private_key_enc) VALUES ($1,'serveur','k2','e2')", [d.A!.t])).rejects.toThrow(/duplicate|unique/);
  });
  it('le journal des validations est en ajout seul pour l\'application', async () => {
    await expect(ctx({ 'app.tenant_id': d.A!.t! }, 'DELETE FROM validations')).rejects.toThrow(/permission denied/);
    await expect(ctx({ 'app.tenant_id': d.A!.t! }, 'UPDATE validations SET scanned_at = now()')).rejects.toThrow(/permission denied/);
  });
});
