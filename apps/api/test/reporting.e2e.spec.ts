import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adminPool, createStaff, createTenant, createTestApp, get, send, superToken, tokenOf, uid } from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Tableau de bord des recettes', () => {
  let app: INestApplication;
  let pool: Pool;
  let sa: string;

  interface Shop { tenantId: string; userId: string; dir: string; roles: Record<string, string>; keyId: string; seq: number;
    L1: Json; L2: Json }
  const mkLine = async (tok: string, stops: string[]) =>
    (await send(app, 'post', '/lignes', tok, { code: `R${uid().toUpperCase()}`, name: `Ligne ${stops.join('-')}`, stops }).expect(201)).body as Json;
  const mkTrip = async (tok: string, lineId: string, at: string, seats: number, status?: string) => {
    const t = (await send(app, 'post', '/departs', tok, { lineId, departureAt: at, seats }).expect(201)).body as Json;
    if (status) await send(app, 'patch', `/departs/${t.id}`, tok, { status }).expect(200);
    return t;
  };
  const shop = async (label: string): Promise<Shop> => {
    const T = await createTenant(app, sa, label);
    const dir = await tokenOf(app, T.adminEmail);
    const roles: Record<string, string> = {};
    for (const r of ['caissier', 'controleur', 'exploitation', 'comptable', 'flotte', 'chauffeur']) roles[r] = await tokenOf(app, (await createStaff(app, dir, r)).email);
    const keyId = (await pool.query("INSERT INTO signing_keys (tenant_id, kind, public_key) VALUES ($1,'poste','pk') RETURNING id", [T.tenantId])).rows[0].id;
    const L1 = await mkLine(dir, ['Ouagadougou', 'Koudougou', 'Bobo-Dioulasso']);
    const L2 = await mkLine(dir, ['Ouagadougou', 'Ouahigouya']);
    return { tenantId: T.tenantId, userId: T.adminId, dir, roles, keyId, seq: 0, L1, L2 };
  };
  interface Sale { soldAt: string; total: number; seats?: number; status?: 'vendu' | 'valide' | 'annule'; method?: 'especes' | 'orange_money' | 'moov_money'; payStatus?: string;
    offline?: boolean; category?: 'plein_tarif' | 'enfant' | 'etudiant'; reference?: string }
  /** Insère un billet avec une date de vente choisie (impossible via l'API, qui date toujours de « maintenant »). */
  const seed = async (s: Shop, line: Json, trip: Json, d: Sale) => {
    const seats = d.seats ?? 1;
    const status = d.status ?? 'vendu';
    const method = d.method ?? 'especes';
    const id = randomUUID();
    const number = ++s.seq;
    await pool.query(
      `INSERT INTO tickets (id, tenant_id, number, line_id, trip_id, from_stop_id, to_stop_id, category, seats, unit_price_xof, total_xof, status, signing_key_id, qr, sold_by, sold_at, offline, validated_at, cancelled_at, cancel_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'qr',$14,$15,$16,$17,$18,$19)`,
      [id, s.tenantId, number, line.id, trip.id, line.stops[0].id, line.stops.at(-1).id, d.category ?? 'plein_tarif', seats, d.total / seats, d.total, status, s.keyId, s.userId,
        d.soldAt, d.offline ?? false, status === 'valide' ? d.soldAt : null, status === 'annule' ? d.soldAt : null, status === 'annule' ? 'Annulation de test' : null],
    );
    const ref = method === 'especes' ? null : (d.reference ?? `R-${uid()}`);
    await pool.query('INSERT INTO payments (tenant_id, ticket_id, method, amount_xof, reference, status) VALUES ($1,$2,$3,$4,$5,$6)',
      [s.tenantId, id, method, d.total, ref, d.payStatus ?? (status === 'annule' ? 'rembourse' : 'encaisse')]);
  };
  const dash = (tok: string, qs = '') => get(app, `/tableau-de-bord${qs}`, tok);

  let A: Shop;
  let T1: Json; let T4: Json; let T5: Json; let T3: Json;

  beforeAll(async () => {
    app = await createTestApp();
    pool = adminPool();
    sa = await superToken(app);
    A = await shop('rapport');
    T1 = await mkTrip(A.dir, A.L1.id, '2026-11-04T08:00:00.000Z', 40);
    const T2 = await mkTrip(A.dir, A.L1.id, '2026-11-12T08:00:00.000Z', 30);
    T3 = await mkTrip(A.dir, A.L1.id, '2026-11-10T20:00:00.000Z', 20);
    T4 = await mkTrip(A.dir, A.L2.id, '2026-11-06T08:00:00.000Z', 10);
    T5 = await mkTrip(A.dir, A.L1.id, '2026-11-09T08:00:00.000Z', 50, 'annule');
    const T6 = await mkTrip(A.dir, A.L2.id, '2026-10-28T08:00:00.000Z', 10);
    // Période testée : du 1er au 10 novembre 2026. Billets pile aux frontières (23:59:59 / 00:00:00).
    await seed(A, A.L1, T1, { soldAt: '2026-11-01T00:00:00Z', total: 8000 });                                                          // a (inclus : début de période)
    await seed(A, A.L1, T1, { soldAt: '2026-11-03T10:00:00Z', total: 16000, seats: 2, status: 'valide', method: 'orange_money' });     // b
    await seed(A, A.L1, T1, { soldAt: '2026-11-03T15:00:00Z', total: 4000, method: 'moov_money', payStatus: 'a_verifier', offline: true, category: 'enfant' }); // c
    await seed(A, A.L1, T3, { soldAt: '2026-11-10T23:59:59Z', total: 8000 });                                                          // d (inclus : dernière seconde)
    await seed(A, A.L1, T1, { soldAt: '2026-11-05T09:00:00Z', total: 8000, status: 'annule' });                                        // e (annulé)
    await seed(A, A.L2, T4, { soldAt: '2026-11-02T08:00:00Z', total: 2000 });                                                          // f
    await seed(A, A.L2, T4, { soldAt: '2026-11-07T12:00:00Z', total: 4000, seats: 2, status: 'valide', offline: true });               // g
    await seed(A, A.L1, T2, { soldAt: '2026-10-31T23:59:59Z', total: 8000 });                                                          // h (période précédente)
    await seed(A, A.L1, T2, { soldAt: '2026-11-11T00:00:00Z', total: 8000 });                                                          // i (exclu : lendemain de la fin)
    await seed(A, A.L2, T6, { soldAt: '2026-10-25T10:00:00Z', total: 2000 });                                                          // j (période précédente)
    await seed(A, A.L1, T2, { soldAt: '2026-10-20T10:00:00Z', total: 8000 });                                                          // k (avant la période précédente)
  });
  afterAll(async () => { await pool.end(); await app.close(); });

  const P = '?from=2026-11-01&to=2026-11-10';

  describe('droits', () => {
    it('directeur, exploitation et comptable consultent ; les autres rôles sont refusés', async () => {
      for (const tok of [A.dir, A.roles.exploitation!, A.roles.comptable!]) {
        await dash(tok, P).expect(200);
        await get(app, `/tableau-de-bord/departs${P}`, tok).expect(200);
        await get(app, `/tableau-de-bord/export${P}`, tok).expect(200);
      }
      for (const r of ['caissier', 'controleur', 'flotte', 'chauffeur']) {
        await dash(A.roles[r]!, P).expect(403);
        await get(app, `/tableau-de-bord/departs${P}`, A.roles[r]).expect(403);
        await get(app, `/tableau-de-bord/export${P}`, A.roles[r]).expect(403);
      }
      await get(app, `/tableau-de-bord${P}`).expect(401);
    });
  });

  describe('totaux (recomptés indépendamment à partir des billets saisis)', () => {
    it('recettes, billets, places, annulations, paiements à vérifier, ventes hors ligne', async () => {
      const d = (await dash(A.dir, P).expect(200)).body;
      expect(d.period).toMatchObject({ from: '2026-11-01', to: '2026-11-10', days: 10, granularity: 'jour', lineId: null });
      expect(d.totals).toMatchObject({
        revenue: 42000, tickets: 6, seats: 8, averageTicket: 7000, cancelledTickets: 1, cancelledAmount: 8000,
        toVerifyTickets: 1, toVerifyAmount: 4000, offlineTickets: 2, offlineRevenue: 8000,
      });
    });
    it('les billets pile à la frontière : 00:00:00 du premier jour inclus, 23:59:59 du dernier inclus, 00:00:00 du lendemain exclu', async () => {
      const d = (await dash(A.dir, P).expect(200)).body;
      const rows = (await get(app, `/tableau-de-bord/export${P}`, A.dir).expect(200)).text.trim().split('\r\n').slice(1);
      expect(rows).toHaveLength(7); // a, b, c, d, e, f, g : ni h (31 oct, 23:59:59) ni i (11 nov, 00:00:00)
      expect(d.totals.tickets + d.totals.cancelledTickets).toBe(7);
    });
    it('évolution par rapport à la période précédente de même durée', async () => {
      const d = (await dash(A.dir, P).expect(200)).body;
      expect(d.previous).toMatchObject({ from: '2026-10-22', to: '2026-10-31', revenue: 10000, tickets: 2, revenueEvolutionPct: 320, ticketsEvolutionPct: 200 });
    });
    it('sans vente sur la période précédente : pas de pourcentage inventé', async () => {
      const d = (await dash(A.dir, '?from=2026-09-01&to=2026-09-10').expect(200)).body;
      expect(d.totals).toMatchObject({ revenue: 0, tickets: 0, averageTicket: 0 });
      expect(d.previous.revenueEvolutionPct).toBeNull();
      expect(d.fill.ratePct).toBeNull();
    });
  });

  describe('séries, lignes, moyens de paiement', () => {
    it('une valeur par jour, jours sans vente à zéro, somme égale au total', async () => {
      const d = (await dash(A.dir, P).expect(200)).body;
      expect(d.series).toHaveLength(10);
      expect(d.series.map((p: Json) => p.date)).toEqual(Array.from({ length: 10 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`));
      const byDay = Object.fromEntries(d.series.map((p: Json) => [p.date, p.revenue]));
      expect(byDay).toMatchObject({ '2026-11-01': 8000, '2026-11-02': 2000, '2026-11-03': 20000, '2026-11-04': 0, '2026-11-07': 4000, '2026-11-10': 8000 });
      expect(d.series.reduce((n: number, p: Json) => n + p.revenue, 0)).toBe(d.totals.revenue);
      expect(d.series.reduce((n: number, p: Json) => n + p.tickets, 0)).toBe(d.totals.tickets);
      expect(d.series.reduce((n: number, p: Json) => n + p.seats, 0)).toBe(d.totals.seats);
    });
    it('regroupement par semaine (lundi) et par mois', async () => {
      const w = (await dash(A.dir, `${P}&granularity=semaine`).expect(200)).body;
      expect(w.series.map((p: Json) => [p.date, p.revenue])).toEqual([['2026-10-26', 8000], ['2026-11-02', 26000], ['2026-11-09', 8000]]);
      const m = (await dash(A.dir, `${P}&granularity=mois`).expect(200)).body;
      expect(m.series.map((p: Json) => [p.date, p.revenue])).toEqual([['2026-11-01', 42000]]);
    });
    it('classement des lignes par recettes, avec taux de remplissage par ligne', async () => {
      const d = (await dash(A.dir, P).expect(200)).body;
      expect(d.lines).toHaveLength(2);
      expect(d.lines[0]).toMatchObject({ lineId: A.L1.id, revenue: 36000, tickets: 4, seats: 5, trips: 2, capacity: 60, soldSeats: 5, fillRatePct: 8.3 });
      expect(d.lines[1]).toMatchObject({ lineId: A.L2.id, revenue: 6000, tickets: 2, seats: 3, trips: 1, capacity: 10, soldSeats: 3, fillRatePct: 30 });
      expect(d.lines.reduce((n: number, l: Json) => n + l.revenue, 0)).toBe(d.totals.revenue);
    });
    it('taux de remplissage global : départs annulés et billets annulés exclus', async () => {
      const d = (await dash(A.dir, P).expect(200)).body;
      expect(d.fill).toEqual({ trips: 3, capacity: 70, soldSeats: 8, ratePct: 11.4 });
    });
    it('répartition par moyen de paiement et par catégorie', async () => {
      const d = (await dash(A.dir, P).expect(200)).body;
      expect(d.byPaymentMethod).toEqual([
        { method: 'especes', tickets: 4, revenue: 22000, toVerifyAmount: 0 },
        { method: 'orange_money', tickets: 1, revenue: 16000, toVerifyAmount: 0 },
        { method: 'moov_money', tickets: 1, revenue: 4000, toVerifyAmount: 4000 },
      ]);
      expect(d.byPaymentMethod.reduce((n: number, m: Json) => n + m.revenue, 0)).toBe(d.totals.revenue);
      expect(d.byCategory).toEqual([
        { category: 'plein_tarif', tickets: 5, seats: 7, revenue: 38000 },
        { category: 'enfant', tickets: 1, seats: 1, revenue: 4000 },
      ]);
    });
  });

  describe('filtre par ligne', () => {
    it('ne compte que la ligne demandée, périodes précédente et remplissage compris', async () => {
      const l1 = (await dash(A.dir, `${P}&lineId=${A.L1.id}`).expect(200)).body;
      expect(l1.totals).toMatchObject({ revenue: 36000, tickets: 4, seats: 5, cancelledTickets: 1, cancelledAmount: 8000, offlineTickets: 1, offlineRevenue: 4000 });
      expect(l1.previous).toMatchObject({ revenue: 8000, tickets: 1 });
      expect(l1.fill).toMatchObject({ trips: 2, capacity: 60 });
      expect(l1.lines).toHaveLength(1);
      const l2 = (await dash(A.dir, `${P}&lineId=${A.L2.id}`).expect(200)).body;
      expect(l2.totals).toMatchObject({ revenue: 6000, tickets: 2, cancelledTickets: 0 });
      expect(l1.totals.revenue + l2.totals.revenue).toBe(42000);
    });
    it('ligne inconnue ou d\'une autre compagnie : 404', async () => {
      await dash(A.dir, `${P}&lineId=${randomUUID()}`).expect(404);
      const B = await shop('autre');
      await dash(A.dir, `${P}&lineId=${B.L1.id}`).expect(404);
    });
  });

  describe('départs', () => {
    it('fréquentation départ par départ, paginée', async () => {
      const r = (await get(app, `/tableau-de-bord/departs${P}`, A.dir).expect(200)).body;
      expect(r.total).toBe(4);
      expect(r.items.map((t: Json) => t.id)).toEqual([T1.id, T4.id, T5.id, T3.id]);
      expect(r.items[0]).toMatchObject({ seats: 40, soldSeats: 4, remaining: 36, fillRatePct: 10, tickets: 3, revenue: 28000, status: 'actif' });
      expect(r.items[1]).toMatchObject({ seats: 10, soldSeats: 3, remaining: 7, fillRatePct: 30, tickets: 2, revenue: 6000 });
      expect(r.items[2]).toMatchObject({ status: 'annule', soldSeats: 0, fillRatePct: 0 });
      expect(r.items[3]).toMatchObject({ seats: 20, soldSeats: 1, remaining: 19, fillRatePct: 5, revenue: 8000 });
      const page = (await get(app, `/tableau-de-bord/departs${P}&limit=2&offset=2`, A.dir).expect(200)).body;
      expect(page.items.map((t: Json) => t.id)).toEqual([T5.id, T3.id]);
      expect(page.total).toBe(4);
      const l2 = (await get(app, `/tableau-de-bord/departs${P}&lineId=${A.L2.id}`, A.dir).expect(200)).body;
      expect(l2.items.map((t: Json) => t.id)).toEqual([T4.id]);
    });
  });

  describe('validation des paramètres', () => {
    it('refuse les périodes et paramètres invalides (400)', async () => {
      await dash(A.dir, '?from=2026-11-10&to=2026-11-01').expect(400);
      await dash(A.dir, '?from=2025-01-01&to=2026-11-01').expect(400); // plus de 366 jours
      await dash(A.dir, '?from=2026-02-30&to=2026-03-01').expect(400);
      await dash(A.dir, '?from=hier').expect(400);
      await dash(A.dir, `${P}&granularity=heure`).expect(400);
      await dash(A.dir, `${P}&lineId=pas-un-uuid`).expect(400);
      await get(app, `/tableau-de-bord/departs${P}&limit=1000`, A.dir).expect(400);
      await dash(A.dir, '?from=2025-11-01&to=2026-10-31').expect(200); // 365 jours : accepté
    });
    it('sans paramètre : les 30 derniers jours, aujourd\'hui compris', async () => {
      const d = (await dash(A.dir).expect(200)).body;
      const today = new Date().toISOString().slice(0, 10);
      expect(d.period).toMatchObject({ to: today, days: 30 });
      expect(Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d.period.from}T00:00:00Z`)).toBe(29 * 24 * 3600 * 1000);
      expect(d.series).toHaveLength(30);
    });
  });

  describe('lien avec les ventes réelles', () => {
    it('les totaux du tableau de bord égalent la somme des billets enregistrés (ventes faites par l\'API)', async () => {
      const R = await shop('reel');
      const trip = await mkTrip(R.dir, R.L1.id, '2027-03-01T08:00:00.000Z', 30);
      const [o, , b] = R.L1.stops.map((s: Json) => s.id);
      for (const [category, price] of [['plein_tarif', 8000], ['enfant', 4000]] as const) {
        await send(app, 'put', `/lignes/${R.L1.id}/tarifs`, R.dir, { fromStopId: o, toStopId: b, category, price }).expect(200);
      }
      const sell = (seats: number, category: string, payment: Json) =>
        send(app, 'post', '/billetterie/ventes', R.roles.caissier!, { ticketId: randomUUID(), tripId: trip.id, fromStopId: o, toStopId: b, category, seats, payment }).expect(201);
      await sell(2, 'plein_tarif', { method: 'especes' });
      await sell(3, 'enfant', { method: 'orange_money', reference: `OM-${uid()}` });
      const cancelled = (await sell(1, 'plein_tarif', { method: 'especes' })).body;
      await send(app, 'post', `/billetterie/tickets/${cancelled.id}/annulation`, R.dir, { reason: 'Client remboursé au guichet' }).expect(200);

      const d = (await dash(R.dir).expect(200)).body;
      const list = (await get(app, '/billetterie/tickets?limit=100', R.dir).expect(200)).body.items as Json[];
      const live = list.filter((t) => t.status !== 'annule');
      expect(d.totals.revenue).toBe(live.reduce((n, t) => n + t.total, 0));
      expect(d.totals.revenue).toBe(2 * 8000 + 3 * 4000);
      expect(d.totals).toMatchObject({ tickets: 2, seats: 5, cancelledTickets: 1, cancelledAmount: 8000 });
      expect(d.series.at(-1)).toMatchObject({ revenue: 28000, tickets: 2 });
      expect(d.byPaymentMethod.map((m: Json) => [m.method, m.revenue])).toEqual([['especes', 16000], ['orange_money', 12000]]);
      expect(d.fill).toMatchObject({ trips: 0 }); // le départ est en 2027 : hors période
    });
  });

  describe('export CSV du journal des ventes', () => {
    it('ouvre directement dans Excel : BOM, séparateur « ; », une ligne par billet, totaux cohérents', async () => {
      const res = await get(app, `/tableau-de-bord/export${P}`, A.dir).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/csv; charset=utf-8/);
      expect(res.headers['content-disposition']).toBe('attachment; filename="ventes_2026-11-01_2026-11-10.csv"');
      expect(res.text.startsWith('\uFEFF"Numéro"')).toBe(true);
      const lines = res.text.trim().split('\r\n');
      const header = lines[0]!.replace('\uFEFF', '').split(';').map((h) => h.replace(/"/g, ''));
      const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(';').map((v, i) => [header[i], v.replace(/^"|"$/g, '')])));
      expect(rows).toHaveLength(7);
      const live = rows.filter((r) => r['Statut du billet'] !== 'annule');
      expect(live.reduce((n, r) => n + Number(r['Total (FCFA)']), 0)).toBe(42000);
      expect(rows.find((r) => r['Statut du billet'] === 'annule')).toMatchObject({ "Justification d'annulation": 'Annulation de test', 'Statut du paiement': 'rembourse' });
      expect(rows.filter((r) => r['Vendu hors ligne'] === 'oui')).toHaveLength(2);
      expect(rows[0]).toMatchObject({ 'Arrêt de départ': 'Ouagadougou', "Arrêt d'arrivée": 'Bobo-Dioulasso' });
      expect(rows.map((r) => Number(r['Numéro']))).toEqual(rows.map((r) => Number(r['Numéro'])).sort((a, b) => a - b));
    });
    it('neutralise l\'injection de formules dans les cellules (références saisies par un caissier)', async () => {
      const X = await shop('inj');
      const trip = await mkTrip(X.dir, X.L1.id, '2026-11-04T08:00:00.000Z', 10);
      await seed(X, X.L1, trip, { soldAt: '2026-11-04T09:00:00Z', total: 8000, method: 'orange_money', reference: '=HYPERLINK("http://pirate.example")' });
      await seed(X, X.L1, trip, { soldAt: '2026-11-04T09:30:00Z', total: 8000, method: 'orange_money', reference: '+33-risque' });
      const csv = (await get(app, '/tableau-de-bord/export?from=2026-11-04&to=2026-11-04', X.dir).expect(200)).text;
      expect(csv).toContain('"\'=HYPERLINK(""http://pirate.example"")"');
      expect(csv).toContain('"\'+33-risque"');
      expect(csv).not.toMatch(/;"=HYPERLINK/);
    });
  });

  describe('isolation entre compagnies', () => {
    it('une compagnie sans vente voit zéro partout, même si une autre a beaucoup vendu', async () => {
      const B = await shop('vide');
      const d = (await dash(B.dir, P).expect(200)).body;
      expect(d.totals).toMatchObject({ revenue: 0, tickets: 0, seats: 0, cancelledTickets: 0, offlineTickets: 0 });
      expect(d.lines).toEqual([]);
      expect(d.byPaymentMethod).toEqual([]);
      expect(d.fill.capacity).toBe(0);
      expect(d.series.every((p: Json) => p.revenue === 0)).toBe(true);
      const csv = (await get(app, `/tableau-de-bord/export${P}`, B.dir).expect(200)).text;
      expect(csv.trim().split('\r\n')).toHaveLength(1);
      expect((await get(app, `/tableau-de-bord/departs${P}`, B.dir).expect(200)).body.total).toBe(0);
    });
  });

  describe('volume : 50 001 billets', () => {
    it('totaux identiques à un comptage direct en base, réponse rapide, export refusé au-delà de 50 000 billets', async () => {
      const S = await shop('volume');
      const trip = await mkTrip(S.dir, S.L1.id, '2026-09-15T08:00:00.000Z', 100);
      await pool.query(
        `INSERT INTO tickets (id, tenant_id, number, line_id, trip_id, from_stop_id, to_stop_id, category, seats, unit_price_xof, total_xof, status, signing_key_id, qr, sold_by, sold_at, cancelled_at, cancel_reason)
         SELECT gen_random_uuid(), $1, g, $2, $3, $4, $5, 'plein_tarif', 1 + (g % 3), 1000, 1000 * (1 + (g % 3)),
                CASE WHEN g % 10 = 0 THEN 'annule' ELSE 'vendu' END, $6, 'qr', $7,
                timestamptz '2026-09-01 00:00:00+00' + (g % 60) * interval '1 day' + (g % 86400) * interval '1 second',
                CASE WHEN g % 10 = 0 THEN now() END, CASE WHEN g % 10 = 0 THEN 'volume' END
         FROM generate_series(1, 50001) g`,
        [S.tenantId, S.L1.id, trip.id, S.L1.stops[0].id, S.L1.stops[2].id, S.keyId, S.userId],
      );
      await pool.query('ANALYZE tickets'); // statistiques à jour après un chargement massif (sinon les contrôles de clés étrangères sont très lents)
      await pool.query("INSERT INTO payments (tenant_id, ticket_id, method, amount_xof, status) SELECT tenant_id, id, 'especes', total_xof, CASE WHEN status = 'annule' THEN 'rembourse' ELSE 'encaisse' END FROM tickets WHERE tenant_id = $1", [S.tenantId]);
      const direct = (await pool.query(
        `SELECT count(*) FILTER (WHERE status <> 'annule') AS tickets, sum(total_xof) FILTER (WHERE status <> 'annule') AS revenue, sum(seats) FILTER (WHERE status <> 'annule') AS seats,
                count(*) FILTER (WHERE status = 'annule') AS cancelled, sum(total_xof) FILTER (WHERE status = 'annule') AS cancelled_amount
         FROM tickets WHERE tenant_id = $1 AND sold_at >= '2026-09-01T00:00:00Z' AND sold_at < '2026-10-31T00:00:00Z'`, [S.tenantId])).rows[0];
      const t0 = Date.now();
      const d = (await dash(S.dir, '?from=2026-09-01&to=2026-10-30').expect(200)).body;
      const elapsed = Date.now() - t0;
      expect(d.totals).toMatchObject({
        tickets: Number(direct.tickets), revenue: Number(direct.revenue), seats: Number(direct.seats),
        cancelledTickets: Number(direct.cancelled), cancelledAmount: Number(direct.cancelled_amount),
      });
      expect(d.series.reduce((n: number, p: Json) => n + p.revenue, 0)).toBe(Number(direct.revenue));
      expect(d.series).toHaveLength(60);
      expect(elapsed).toBeLessThan(4000);
      const tooBig = await request(app.getHttpServer()).get('/api/v1/tableau-de-bord/export?from=2026-09-01&to=2026-10-30').set('Authorization', `Bearer ${S.dir}`);
      expect(tooBig.status).toBe(400);
      expect(tooBig.body.message).toMatch(/50000|50 000|réduisez/);
      await get(app, '/tableau-de-bord/export?from=2026-09-01&to=2026-09-02', S.dir).expect(200);
    });
  });
});
