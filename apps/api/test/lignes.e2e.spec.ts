import { INestApplication } from '@nestjs/common';
import { adminPool, createStaff, createTenant, createTestApp, del, get, send, superToken, tokenOf, uid } from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Lignes, arrêts, tarifs et départs', () => {
  let app: INestApplication;
  let dirA: string;
  let dirB: string;
  const tokens: Record<string, string> = {};
  const STOPS = ['Ouagadougou', 'Koudougou', 'Bobo-Dioulasso'];
  const mkLine = async (tok = dirA, stops = STOPS): Promise<Json> =>
    (await send(app, 'post', '/lignes', tok, { code: `L${uid().toUpperCase()}`, name: 'Ouaga - Bobo', stops }).expect(201)).body;
  const at = (days: number, hour = 8) => new Date(Date.UTC(2027, 0, 1 + days, hour)).toISOString();

  beforeAll(async () => {
    app = await createTestApp();
    const sa = await superToken(app);
    dirA = await tokenOf(app, (await createTenant(app, sa, 'lia')).adminEmail);
    dirB = await tokenOf(app, (await createTenant(app, sa, 'lib')).adminEmail);
    for (const role of ['caissier', 'controleur', 'chauffeur', 'exploitation', 'flotte', 'comptable']) {
      tokens[role] = await tokenOf(app, (await createStaff(app, dirA, role)).email);
    }
  });
  afterAll(async () => app.close());

  describe('droits par rôle (matrice PRD §3.7)', () => {
    it('exploitation et directeur écrivent ; caissier, contrôleur, chauffeur lisent seulement', async () => {
      await send(app, 'post', '/lignes', tokens.exploitation!, { code: `X${uid().toUpperCase()}`, name: 'Ligne Exploit', stops: STOPS }).expect(201);
      for (const role of ['caissier', 'controleur', 'chauffeur']) {
        await get(app, '/lignes', tokens[role]).expect(200);
        await get(app, '/departs', tokens[role]).expect(200);
        await send(app, 'post', '/lignes', tokens[role]!, { code: `Y${uid().toUpperCase()}`, name: 'Interdit', stops: STOPS }).expect(403);
        await send(app, 'post', '/departs', tokens[role]!, { lineId: '00000000-0000-4000-8000-000000000000', departureAt: at(1), seats: 50 }).expect(403);
      }
    });
    it('flotte et comptable n\'ont aucun accès aux lignes', async () => {
      for (const role of ['flotte', 'comptable']) {
        await get(app, '/lignes', tokens[role]).expect(403);
        await get(app, '/departs', tokens[role]).expect(403);
      }
    });
  });

  describe('lignes et arrêts', () => {
    it('crée une ligne avec arrêts ordonnés ; code mis en majuscules', async () => {
      const code = `ab-${uid()}`;
      const res = await send(app, 'post', '/lignes', dirA, { code, name: 'Ligne Test', stops: STOPS }).expect(201);
      expect(res.body.code).toBe(code.toUpperCase());
      expect(res.body.stops.map((s: Json) => [s.name, s.position])).toEqual([['Ouagadougou', 1], ['Koudougou', 2], ['Bobo-Dioulasso', 3]]);
      await send(app, 'post', '/lignes', dirA, { code, name: 'Doublon', stops: STOPS }).expect(409);
    });
    it('valide les entrées (400)', async () => {
      const base = { code: `V${uid().toUpperCase()}`, name: 'Valide Ligne' };
      await send(app, 'post', '/lignes', dirA, { ...base, stops: ['Seul'] }).expect(400);
      await send(app, 'post', '/lignes', dirA, { ...base, stops: ['Ouaga', 'ouaga'] }).expect(400);
      await send(app, 'post', '/lignes', dirA, { ...base, code: 'pas valide!', stops: STOPS }).expect(400);
    });
    it('insère un arrêt au milieu : positions décalées et continues', async () => {
      const line = await mkLine();
      const res = (await send(app, 'post', `/lignes/${line.id}/arrets`, dirA, { name: 'Boromo', position: 2 }).expect(201)).body;
      expect(res.stops.map((s: Json) => [s.name, s.position])).toEqual([['Ouagadougou', 1], ['Boromo', 2], ['Koudougou', 3], ['Bobo-Dioulasso', 4]]);
      const end = (await send(app, 'post', `/lignes/${line.id}/arrets`, dirA, { name: 'Banfora' }).expect(201)).body;
      expect(end.stops.at(-1)).toMatchObject({ name: 'Banfora', position: 5 });
      await send(app, 'post', `/lignes/${line.id}/arrets`, dirA, { name: 'Trop Loin', position: 9 }).expect(400);
      await send(app, 'post', `/lignes/${line.id}/arrets`, dirA, { name: 'koudougou' }).expect(409);
    });
    it('supprime un arrêt : positions recompactées ; jamais moins de 2 arrêts', async () => {
      const line = await mkLine();
      const mid = line.stops[1].id;
      const res = (await del(app, `/lignes/${line.id}/arrets/${mid}`, dirA).expect(200)).body;
      expect(res.stops.map((s: Json) => s.position)).toEqual([1, 2]);
      await del(app, `/lignes/${line.id}/arrets/${res.stops[0].id}`, dirA).expect(400);
    });
    it('renomme un arrêt ; refuse un nom déjà pris', async () => {
      const line = await mkLine();
      const res = (await send(app, 'patch', `/lignes/${line.id}/arrets/${line.stops[1].id}`, dirA, { name: 'Réo' }).expect(200)).body;
      expect(res.stops[1].name).toBe('Réo');
      await send(app, 'patch', `/lignes/${line.id}/arrets/${line.stops[1].id}`, dirA, { name: 'ouagadougou' }).expect(409);
    });
    it('désactive une ligne', async () => {
      const line = await mkLine();
      const res = await send(app, 'patch', `/lignes/${line.id}`, dirA, { active: false }).expect(200);
      expect(res.body.active).toBe(false);
      await send(app, 'patch', `/lignes/${line.id}`, dirA, {}).expect(400);
    });
  });

  describe('tarifs', () => {
    let line: Json;
    beforeAll(async () => { line = await mkLine(); });
    const fare = (tok: string, body: object, id = line.id) => send(app, 'put', `/lignes/${id}/tarifs`, tok, body);

    it('définit un tarif, puis le met à jour (même tarif, nouveau prix) ; trace l\'ancien et le nouveau prix', async () => {
      const [o, k, b] = line.stops.map((s: Json) => s.id);
      const first = (await fare(dirA, { fromStopId: o, toStopId: b, price: 8000 }).expect(200)).body;
      expect(first).toMatchObject({ category: 'plein_tarif', price: 8000, active: true });
      const second = (await fare(tokens.exploitation!, { fromStopId: o, toStopId: b, price: 9000 }).expect(200)).body;
      expect(second.id).toBe(first.id);
      await fare(dirA, { fromStopId: o, toStopId: b, category: 'etudiant', price: 6500 }).expect(200);
      await fare(dirA, { fromStopId: o, toStopId: k, price: 4000 }).expect(200);
      const detail = (await get(app, `/lignes/${line.id}`, tokens.caissier).expect(200)).body;
      expect(detail.fares).toHaveLength(3);

      const pool = adminPool();
      const log = await pool.query("SELECT before, after FROM audit_logs WHERE object_id = $1 AND action = 'fare.changed' ORDER BY id", [first.id]);
      await pool.end();
      expect(log.rows).toHaveLength(2);
      expect(log.rows[0].before).toBeNull();
      expect(log.rows[1].before.price).toBe(8000);
      expect(log.rows[1].after.price).toBe(9000);
    });
    it('refuse un sens inverse, deux fois le même arrêt, un arrêt d\'une autre ligne (400)', async () => {
      const [o, , b] = line.stops.map((s: Json) => s.id);
      await fare(dirA, { fromStopId: b, toStopId: o, price: 8000 }).expect(400);
      await fare(dirA, { fromStopId: o, toStopId: o, price: 8000 }).expect(400);
      const other = await mkLine();
      await fare(dirA, { fromStopId: o, toStopId: other.stops[2].id, price: 8000 }).expect(400);
    });
    it('valide le prix et la catégorie (400)', async () => {
      const [o, , b] = line.stops.map((s: Json) => s.id);
      for (const price of [0, -5, 12.5, 2_000_000]) await fare(dirA, { fromStopId: o, toStopId: b, price }).expect(400);
      await fare(dirA, { fromStopId: o, toStopId: b, category: 'vip', price: 5000 }).expect(400);
    });
    it('caissier et contrôleur ne peuvent pas modifier les tarifs (403)', async () => {
      const [o, , b] = line.stops.map((s: Json) => s.id);
      for (const role of ['caissier', 'controleur']) await fare(tokens[role]!, { fromStopId: o, toStopId: b, price: 1 }).expect(403);
    });
    it('désactive puis réactive un tarif ; un arrêt utilisé par un tarif ne se supprime pas (409)', async () => {
      const detail = (await get(app, `/lignes/${line.id}`, dirA).expect(200)).body;
      const f = detail.fares[0];
      const off = (await send(app, 'patch', `/lignes/${line.id}/tarifs/${f.id}`, dirA, { active: false }).expect(200)).body;
      expect(off.active).toBe(false);
      await send(app, 'patch', `/lignes/${line.id}/tarifs/${f.id}`, dirA, { active: true }).expect(200);
      await del(app, `/lignes/${line.id}/arrets/${f.fromStopId}`, dirA).expect(409);
    });
  });

  describe('départs', () => {
    let line: Json;
    beforeAll(async () => { line = await mkLine(); });

    it('crée, refuse le doublon, refuse une ligne désactivée', async () => {
      const t = (await send(app, 'post', '/departs', dirA, { lineId: line.id, departureAt: at(1), seats: 50 }).expect(201)).body;
      expect(t).toMatchObject({ lineId: line.id, seats: 50, status: 'actif' });
      await send(app, 'post', '/departs', dirA, { lineId: line.id, departureAt: at(1), seats: 40 }).expect(409);
      const off = await mkLine();
      await send(app, 'patch', `/lignes/${off.id}`, dirA, { active: false }).expect(200);
      await send(app, 'post', '/departs', dirA, { lineId: off.id, departureAt: at(1), seats: 40 }).expect(409);
    });
    it('valide les entrées (400)', async () => {
      await send(app, 'post', '/departs', dirA, { lineId: line.id, departureAt: 'demain matin', seats: 50 }).expect(400);
      await send(app, 'post', '/departs', dirA, { lineId: line.id, departureAt: at(2), seats: 0 }).expect(400);
      await send(app, 'post', '/departs', dirA, { lineId: line.id, departureAt: at(2), seats: 500 }).expect(400);
      await send(app, 'post', '/departs', dirA, { lineId: 'pas-un-uuid', departureAt: at(2), seats: 50 }).expect(400);
    });
    it('liste filtrée par ligne et par période, paginée', async () => {
      const l2 = await mkLine();
      for (let d = 10; d < 15; d++) await send(app, 'post', '/departs', dirA, { lineId: l2.id, departureAt: at(d), seats: 60 }).expect(201);
      const all = (await get(app, `/departs?lineId=${l2.id}`, tokens.caissier).expect(200)).body;
      expect(all.total).toBe(5);
      expect(all.items.map((i: Json) => i.departureAt)).toEqual([10, 11, 12, 13, 14].map((d) => at(d)));
      const range = (await get(app, `/departs?lineId=${l2.id}&from=${encodeURIComponent(at(11))}&to=${encodeURIComponent(at(13))}`, dirA).expect(200)).body;
      expect(range.total).toBe(3);
      const page = (await get(app, `/departs?lineId=${l2.id}&limit=2&offset=4`, dirA).expect(200)).body;
      expect(page.items).toHaveLength(1);
      expect(page.total).toBe(5);
    });
    it('retarde puis annule un départ ; change les places ; journalise le changement de statut', async () => {
      const t = (await send(app, 'post', '/departs', dirA, { lineId: line.id, departureAt: at(20), seats: 50 }).expect(201)).body;
      const late = (await send(app, 'patch', `/departs/${t.id}`, tokens.exploitation!, { status: 'retarde', departureAt: at(20, 10) }).expect(200)).body;
      expect(late).toMatchObject({ status: 'retarde', departureAt: at(20, 10) });
      const seats = (await send(app, 'patch', `/departs/${t.id}`, dirA, { seats: 45 }).expect(200)).body;
      expect(seats.seats).toBe(45);
      await send(app, 'patch', `/departs/${t.id}`, dirA, { status: 'annule' }).expect(200);
      await send(app, 'patch', `/departs/${t.id}`, dirA, { status: 'inconnu' }).expect(400);
      await send(app, 'patch', `/departs/${t.id}`, tokens.caissier!, { status: 'actif' }).expect(403);
      const pool = adminPool();
      const log = await pool.query("SELECT action FROM audit_logs WHERE object_id = $1 ORDER BY id", [t.id]);
      await pool.end();
      expect(log.rows.map((r) => r.action)).toEqual(['trip.created', 'trip.status_changed', 'trip.updated', 'trip.status_changed']);
    });
    it('refuse de déplacer un départ sur l\'horaire d\'un autre (409)', async () => {
      const a = (await send(app, 'post', '/departs', dirA, { lineId: line.id, departureAt: at(30), seats: 50 }).expect(201)).body;
      await send(app, 'post', '/departs', dirA, { lineId: line.id, departureAt: at(31), seats: 50 }).expect(201);
      await send(app, 'patch', `/departs/${a.id}`, dirA, { departureAt: at(31) }).expect(409);
    });
  });

  describe('isolation entre compagnies', () => {
    it('A ne voit ni ne modifie lignes, arrêts, tarifs et départs de B', async () => {
      const lineB = await mkLine(dirB);
      const tripB = (await send(app, 'post', '/departs', dirB, { lineId: lineB.id, departureAt: at(40), seats: 50 }).expect(201)).body;
      const [o, , b] = lineB.stops.map((s: Json) => s.id);

      const listA = (await get(app, '/lignes', dirA).expect(200)).body as Json[];
      expect(listA.map((l) => l.id)).not.toContain(lineB.id);
      await get(app, `/lignes/${lineB.id}`, dirA).expect(404);
      await send(app, 'patch', `/lignes/${lineB.id}`, dirA, { active: false }).expect(404);
      await send(app, 'post', `/lignes/${lineB.id}/arrets`, dirA, { name: 'Intrus' }).expect(404);
      await send(app, 'put', `/lignes/${lineB.id}/tarifs`, dirA, { fromStopId: o, toStopId: b, price: 1 }).expect(404);
      await del(app, `/lignes/${lineB.id}/arrets/${o}`, dirA).expect(404);
      await get(app, `/departs/${tripB.id}`, dirA).expect(404);
      await send(app, 'patch', `/departs/${tripB.id}`, dirA, { status: 'annule' }).expect(404);
      await send(app, 'post', '/departs', dirA, { lineId: lineB.id, departureAt: at(41), seats: 50 }).expect(404);
      const tripsA = (await get(app, '/departs?limit=100', dirA).expect(200)).body.items as Json[];
      expect(tripsA.map((t) => t.id)).not.toContain(tripB.id);

      const lineA = await mkLine(dirA);
      await send(app, 'put', `/lignes/${lineA.id}/tarifs`, dirA, { fromStopId: o, toStopId: b, price: 1 }).expect(400);
      expect((await get(app, `/lignes/${lineB.id}`, dirB).expect(200)).body.active).toBe(true);
    });
    it('un même code de ligne peut exister dans deux compagnies', async () => {
      const code = `SAME-${uid()}`.slice(0, 12).toUpperCase();
      await send(app, 'post', '/lignes', dirA, { code, name: 'Ligne Commune', stops: STOPS }).expect(201);
      await send(app, 'post', '/lignes', dirB, { code, name: 'Ligne Commune', stops: STOPS }).expect(201);
    });
  });
});
