import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { adminPool, appPool, uid } from './helpers';

describe('Base de données étape 5 : postes, plages, anomalies', () => {
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

  beforeAll(async () => {
    admin = adminPool();
    app = appPool();
    for (const k of ['A', 'B']) {
      const t = await one('INSERT INTO tenants (name, slug) VALUES ($1,$1) RETURNING id', [`r5-${k.toLowerCase()}-${uid()}`]);
      const u = await one("INSERT INTO users (tenant_id,email,full_name,password_hash) VALUES ($1,$2,'u','x') RETURNING id", [t, `u-${uid()}@r5.test`]);
      const dev = await one("INSERT INTO devices (tenant_id, name, kind, public_key, requested_by) VALUES ($1,'P','vente',$2,$3) RETURNING id", [t, `pk-${uid()}`, u]);
      await admin.query('INSERT INTO number_ranges (tenant_id, device_id, start_number, end_number) VALUES ($1,$2,1,50)', [t, dev]);
      const an = await one("INSERT INTO anomalies (tenant_id, kind, device_id) VALUES ($1,'surreservation',$2) RETURNING id", [t, dev]);
      d[k] = { t, u, dev, an };
    }
  });
  afterAll(async () => { await admin.end(); await app.end(); });

  it('sans contexte, rien n\'est visible ; avec un contexte, seulement sa compagnie', async () => {
    for (const t of ['devices', 'number_ranges', 'anomalies']) {
      expect((await app.query(`SELECT 1 FROM ${t}`)).rowCount).toBe(0);
      const r = await ctx({ 'app.tenant_id': d.A!.t! }, `SELECT tenant_id FROM ${t}`);
      expect(r.rowCount).toBeGreaterThan(0);
      expect(r.rows.every((x) => x.tenant_id === d.A!.t)).toBe(true);
    }
  });
  it('refuse d\'écrire dans une autre compagnie ; clés composites contre le mélange', async () => {
    const A = d.A!; const B = d.B!;
    await expect(ctx({ 'app.tenant_id': A.t! }, "INSERT INTO devices (tenant_id, name, kind, public_key, requested_by) VALUES ($1,'x','vente',$2,$3)", [B.t, `pk-${uid()}`, B.u])).rejects.toThrow(/row-level security/);
    await expect(ctx({ 'app.is_platform': 'on' }, 'INSERT INTO number_ranges (tenant_id, device_id, start_number, end_number) VALUES ($1,$2,100,110)', [A.t, B.dev])).rejects.toThrow(/foreign key/);
    expect((await ctx({ 'app.tenant_id': A.t! }, "UPDATE devices SET status = 'revoque' WHERE tenant_id = $1", [B.t])).rowCount).toBe(0);
  });
  it('plages de numéros : une plage vide ou inversée est impossible, et une plage ne se modifie ni ne se supprime', async () => {
    await expect(admin.query('INSERT INTO number_ranges (tenant_id, device_id, start_number, end_number) VALUES ($1,$2,20,10)', [d.A!.t, d.A!.dev])).rejects.toThrow(/check/);
    await expect(ctx({ 'app.tenant_id': d.A!.t! }, 'UPDATE number_ranges SET end_number = 999')).rejects.toThrow(/permission denied/);
    await expect(ctx({ 'app.tenant_id': d.A!.t! }, 'DELETE FROM number_ranges')).rejects.toThrow(/permission denied/);
  });
  it('anomalies : seul le traitement est modifiable, jamais le contenu ni la suppression', async () => {
    await expect(ctx({ 'app.tenant_id': d.A!.t! }, "UPDATE anomalies SET kind = 'autre'")).rejects.toThrow(/permission denied/);
    await expect(ctx({ 'app.tenant_id': d.A!.t! }, 'DELETE FROM anomalies')).rejects.toThrow(/permission denied/);
    const r = await ctx({ 'app.tenant_id': d.A!.t! }, "UPDATE anomalies SET status = 'traitee', handled_at = now() WHERE id = $1", [d.A!.an]);
    expect(r.rowCount).toBe(1);
  });
  it('un poste révoqué exige une date et une raison ; une clé publique ne sert qu\'une fois par compagnie', async () => {
    await expect(admin.query("UPDATE devices SET status = 'revoque' WHERE id = $1", [d.A!.dev])).rejects.toThrow(/check/);
    const pk = (await admin.query('SELECT public_key FROM devices WHERE id = $1', [d.A!.dev])).rows[0].public_key;
    await expect(admin.query("INSERT INTO devices (tenant_id, name, kind, public_key, requested_by) VALUES ($1,'bis','vente',$2,$3)", [d.A!.t, pk, d.A!.u])).rejects.toThrow(/duplicate|unique/);
  });
  it('clés de signature : seul le statut est modifiable (révocation), jamais la clé', async () => {
    const k = await one("INSERT INTO signing_keys (tenant_id, kind, public_key) VALUES ($1,'poste',$2) RETURNING id", [d.A!.t, `pub-${uid()}`]);
    await expect(ctx({ 'app.tenant_id': d.A!.t! }, "UPDATE signing_keys SET public_key = 'autre' WHERE id = $1", [k])).rejects.toThrow(/permission denied/);
    await expect(ctx({ 'app.tenant_id': d.A!.t! }, 'DELETE FROM signing_keys WHERE id = $1', [k])).rejects.toThrow(/permission denied/);
    const r = await ctx({ 'app.tenant_id': d.A!.t! }, "UPDATE signing_keys SET status = 'revoque', revoked_at = now() WHERE id = $1", [k]);
    expect(r.rowCount).toBe(1);
  });
  it('un billet ne peut référencer le poste d\'une autre compagnie', async () => {
    const A = d.A!; const B = d.B!;
    const l = await one("INSERT INTO lines (tenant_id, code, name) VALUES ($1,'R5','L') RETURNING id", [A.t]);
    const s1 = await one("INSERT INTO stops (tenant_id, line_id, name, position) VALUES ($1,$2,'Un',1) RETURNING id", [A.t, l]);
    const s2 = await one("INSERT INTO stops (tenant_id, line_id, name, position) VALUES ($1,$2,'Deux',2) RETURNING id", [A.t, l]);
    const tr = await one("INSERT INTO trips (tenant_id, line_id, departure_at, seats) VALUES ($1,$2,now(),10) RETURNING id", [A.t, l]);
    const key = await one("INSERT INTO signing_keys (tenant_id, kind, public_key, private_key_enc) VALUES ($1,'serveur','pk','e') RETURNING id", [A.t]);
    await expect(admin.query(
      `INSERT INTO tickets (id, tenant_id, number, line_id, trip_id, from_stop_id, to_stop_id, category, seats, unit_price_xof, total_xof, signing_key_id, qr, sold_by, device_id, offline)
       VALUES ($1,$2,1,$3,$4,$5,$6,'plein_tarif',1,100,100,$7,'qr',$8,$9,true)`, [randomUUID(), A.t, l, tr, s1, s2, key, A.u, B.dev],
    )).rejects.toThrow(/foreign key/);
  });
});
