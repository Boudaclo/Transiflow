import { randomUUID, createPublicKey, verify } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { PAYLOAD_LENGTH, decodeTicketQr, encodeTicketQr, fromBase64Url } from '@transport/shared';
import { adminPool, appPool, createStaff, createTenant, createTestApp, get, send, superToken, tokenOf, uid } from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

describe('Billetterie en ligne et contrôle', () => {
  let app: INestApplication;
  let sa: string;
  let dirA: string;
  let dirB: string;
  const t: Record<string, string> = {};
  let O: string; // Ouagadougou
  let K: string; // Koudougou
  let B: string; // Bobo-Dioulasso
  let day = 0;

  const nextAt = () => new Date(Date.UTC(2027, 0, 1 + day++, 8)).toISOString();
  const mkLine = async (tok: string) => {
    const line = (await send(app, 'post', '/lignes', tok, { code: `L${uid().toUpperCase()}`, name: 'Ouaga - Bobo', stops: ['Ouagadougou', 'Koudougou', 'Bobo-Dioulasso'] }).expect(201)).body;
    const [o, k, b] = line.stops.map((s: Json) => s.id);
    for (const [category, price] of [['plein_tarif', 8000], ['enfant', 4000], ['etudiant', 6500]] as const) {
      await send(app, 'put', `/lignes/${line.id}/tarifs`, tok, { fromStopId: o, toStopId: b, category, price }).expect(200);
    }
    return { id: line.id as string, o: o as string, k: k as string, b: b as string };
  };
  const mkTrip = async (tok: string, lineId: string, seats = 10) =>
    (await send(app, 'post', '/departs', tok, { lineId, departureAt: nextAt(), seats }).expect(201)).body as Json;
  const sale = (tok: string, tripId: string, over: Json = {}) =>
    send(app, 'post', '/billetterie/ventes', tok, { ticketId: randomUUID(), tripId, fromStopId: O, toStopId: B, seats: 1, payment: { method: 'especes' }, ...over });
  const scan = (tok: string, body: Json) => send(app, 'post', '/controle/validations', tok, body);
  const nodeVerify = (qr: string, publicKeyB64: string) => {
    const d = decodeTicketQr(qr);
    const key = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(fromBase64Url(publicKeyB64))]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(d.payloadBytes), key, Buffer.from(d.signature));
  };

  let lineA: Awaited<ReturnType<typeof mkLine>>;
  let tripA: Json;

  beforeAll(async () => {
    app = await createTestApp();
    sa = await superToken(app);
    const A = await createTenant(app, sa, 'bia');
    const Bt = await createTenant(app, sa, 'bib');
    dirA = await tokenOf(app, A.adminEmail);
    dirB = await tokenOf(app, Bt.adminEmail);
    for (const role of ['caissier', 'controleur', 'comptable', 'flotte', 'exploitation', 'chauffeur']) {
      t[role] = await tokenOf(app, (await createStaff(app, dirA, role)).email);
    }
    lineA = await mkLine(dirA);
    ({ o: O, k: K, b: B } = lineA);
    tripA = await mkTrip(dirA, lineA.id, 50);
  });
  afterAll(async () => app.close());

  describe('droits par rôle', () => {
    it('caissier et directeur vendent ; les autres rôles reçoivent 403', async () => {
      await sale(t.caissier!, tripA.id).expect(201);
      await sale(dirA, tripA.id).expect(201);
      for (const role of ['controleur', 'comptable', 'flotte', 'exploitation', 'chauffeur']) await sale(t[role]!, tripA.id).expect(403);
    });
    it('lecture des billets : caissier et directeur seulement', async () => {
      await get(app, '/billetterie/tickets', t.caissier).expect(200);
      await get(app, '/billetterie/departs', t.caissier).expect(200);
      for (const role of ['controleur', 'comptable', 'flotte', 'chauffeur']) await get(app, '/billetterie/tickets', t[role]).expect(403);
    });
    it('le contrôle valide : contrôleur et directeur ; pas le caissier', async () => {
      const s = (await sale(t.caissier!, tripA.id).expect(201)).body;
      await scan(t.caissier!, { number: s.number }).expect(403);
      await scan(t.comptable!, { number: s.number }).expect(403);
      await scan(t.controleur!, { number: s.number }).expect(200);
    });
    it('l\'annulation est réservée au directeur', async () => {
      const s = (await sale(t.caissier!, tripA.id).expect(201)).body;
      await send(app, 'post', `/billetterie/tickets/${s.id}/annulation`, t.caissier!, { reason: 'Erreur de saisie' }).expect(403);
    });
  });

  describe('vente', () => {
    it('crée un billet numéroté, au prix serveur, avec un QR signé', async () => {
      const res = await sale(t.caissier!, tripA.id, { seats: 2, payment: { method: 'orange_money', reference: `OM-${uid()}` } }).expect(201);
      const s = res.body;
      expect(s).toMatchObject({ status: 'vendu', category: 'plein_tarif', seats: 2, unitPrice: 8000, total: 16000 });
      expect(s.from.name).toBe('Ouagadougou');
      expect(s.to.name).toBe('Bobo-Dioulasso');
      expect(s.trip).toMatchObject({ id: tripA.id, lineName: 'Ouaga - Bobo' });
      expect(s.payment).toMatchObject({ method: 'orange_money', status: 'encaisse' });
      expect(typeof s.number).toBe('number');
      expect(s.qr.length).toBeLessThan(200);
    });
    it('les numéros sont uniques et croissants', async () => {
      const nums = [] as number[];
      for (let i = 0; i < 4; i++) nums.push((await sale(t.caissier!, tripA.id).expect(201)).body.number);
      expect(new Set(nums).size).toBe(4);
      expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    });
    it('applique le tarif de la catégorie ; le client ne fixe jamais le prix', async () => {
      const kid = (await sale(t.caissier!, tripA.id, { category: 'enfant', seats: 3 }).expect(201)).body;
      expect(kid).toMatchObject({ unitPrice: 4000, total: 12000 });
      const stu = (await sale(t.caissier!, tripA.id, { category: 'etudiant', total: 1, unitPrice: 1, price: 1 }).expect(201)).body;
      expect(stu.unitPrice).toBe(6500);
    });
    it('refuse sans tarif actif (422) : trajet sans tarif, sens inverse, tarif désactivé', async () => {
      await sale(t.caissier!, tripA.id, { fromStopId: O, toStopId: K }).expect(422);
      await sale(t.caissier!, tripA.id, { fromStopId: B, toStopId: O }).expect(422);
      const line = await mkLine(dirA);
      const trip = await mkTrip(dirA, line.id);
      const detail = (await get(app, `/lignes/${line.id}`, dirA).expect(200)).body;
      const fare = detail.fares.find((f: Json) => f.category === 'plein_tarif');
      await send(app, 'patch', `/lignes/${line.id}/tarifs/${fare.id}`, dirA, { active: false }).expect(200);
      await sale(t.caissier!, trip.id, { fromStopId: line.o, toStopId: line.b }).expect(422);
      await sale(t.caissier!, trip.id, { fromStopId: line.o, toStopId: line.b, category: 'enfant' }).expect(201);
    });
    it('vente rejouée : même identifiant et même contenu = même billet (200) ; contenu différent = 409', async () => {
      const trip = await mkTrip(dirA, lineA.id, 5);
      const ticketId = randomUUID();
      const first = await sale(t.caissier!, trip.id, { ticketId, seats: 2 }).expect(201);
      const replay = await sale(t.caissier!, trip.id, { ticketId, seats: 2 }).expect(200);
      expect(replay.body.id).toBe(first.body.id);
      expect(replay.body.number).toBe(first.body.number);
      expect(replay.body.qr).toBe(first.body.qr);
      await sale(t.caissier!, trip.id, { ticketId, seats: 1 }).expect(409);
      const dispo = (await get(app, `/billetterie/departs?lineId=${lineA.id}&limit=100`, t.caissier).expect(200)).body.items.find((x: Json) => x.id === trip.id);
      expect(dispo).toMatchObject({ sold: 2, remaining: 3 });
    });
    it('valide les entrées (400)', async () => {
      await sale(t.caissier!, tripA.id, { ticketId: 'pas-un-uuid' }).expect(400);
      await sale(t.caissier!, tripA.id, { seats: 0 }).expect(400);
      await sale(t.caissier!, tripA.id, { seats: 11 }).expect(400);
      await sale(t.caissier!, tripA.id, { payment: { method: 'orange_money' } }).expect(400);
      await sale(t.caissier!, tripA.id, { payment: { method: 'cheque' } }).expect(400);
      await sale(t.caissier!, tripA.id, { category: 'vip' }).expect(400);
    });
    it('refuse deux fois la même référence de paiement mobile (409)', async () => {
      const ref = `MM-${uid()}`;
      await sale(t.caissier!, tripA.id, { payment: { method: 'moov_money', reference: ref } }).expect(201);
      await sale(t.caissier!, tripA.id, { payment: { method: 'moov_money', reference: ref } }).expect(409);
    });
    it('départ annulé, départ ou client inconnu', async () => {
      const trip = await mkTrip(dirA, lineA.id);
      await send(app, 'patch', `/departs/${trip.id}`, dirA, { status: 'annule' }).expect(200);
      await sale(t.caissier!, trip.id).expect(409);
      await sale(t.caissier!, randomUUID()).expect(404);
      await sale(t.caissier!, tripA.id, { clientId: randomUUID() }).expect(404);
      const client = (await send(app, 'post', '/clients', t.caissier!, { fullName: 'Awa Ouédraogo', phone: `+22670${Math.floor(100000 + Math.random() * 899999)}` }).expect(201)).body;
      expect((await sale(t.caissier!, tripA.id, { clientId: client.id }).expect(201)).body.clientId).toBe(client.id);
    });
    it('un départ en retard reste vendable', async () => {
      const trip = await mkTrip(dirA, lineA.id);
      await send(app, 'patch', `/departs/${trip.id}`, dirA, { status: 'retarde' }).expect(200);
      await sale(t.caissier!, trip.id).expect(201);
    });
  });

  describe('places', () => {
    it('ne vend jamais plus de places que la capacité ; l\'annulation libère les places', async () => {
      const trip = await mkTrip(dirA, lineA.id, 3);
      await sale(t.caissier!, trip.id, { seats: 2 }).expect(201);
      const over = await sale(t.caissier!, trip.id, { seats: 2 }).expect(409);
      expect(over.body.message).toMatch(/restant : 1/);
      const last = (await sale(t.caissier!, trip.id, { seats: 1 }).expect(201)).body;
      await sale(t.caissier!, trip.id, { seats: 1 }).expect(409);
      await send(app, 'post', `/billetterie/tickets/${last.id}/annulation`, dirA, { reason: 'Client renonce au voyage' }).expect(200);
      await sale(t.caissier!, trip.id, { seats: 1 }).expect(201);
    });
    it('ventes simultanées sur un départ presque plein : jamais de survente', async () => {
      const trip = await mkTrip(dirA, lineA.id, 3);
      const results = await Promise.all(Array.from({ length: 8 }, () => sale(t.caissier!, trip.id)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(3);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      const numbers = results.filter((r) => r.status === 201).map((r) => r.body.number);
      expect(new Set(numbers).size).toBe(3);
      const dispo = (await get(app, `/billetterie/departs?lineId=${lineA.id}&limit=100`, t.caissier).expect(200)).body.items.find((x: Json) => x.id === trip.id);
      expect(dispo.remaining).toBe(0);
    });
  });

  describe('QR signé (Ed25519)', () => {
    it('contient les bonnes données et se vérifie avec la clé publique, indépendamment de l\'API', async () => {
      const s = (await sale(t.caissier!, tripA.id, { seats: 2 }).expect(201)).body;
      const d = decodeTicketQr(s.qr);
      expect(d.payload).toMatchObject({ number: s.number, price: s.total, seats: 2, ticketId: s.id, tripId: tripA.id });
      expect(d.payload.departureAt).toBe(Math.floor(new Date(tripA.departureAt).getTime() / 1000));
      expect(d.payloadBytes).toHaveLength(PAYLOAD_LENGTH);
      const keys = (await get(app, '/controle/cles', t.controleur).expect(200)).body as Json[];
      const key = keys.find((k) => k.id === d.payload.keyId)!;
      expect(key).toMatchObject({ kind: 'serveur', status: 'actif' });
      expect(nodeVerify(s.qr, key.publicKey)).toBe(true);
      expect(JSON.stringify(d.payload)).not.toMatch(/nom|phone|email/i);
    });
    it('un QR modifié n\'est plus valide', async () => {
      const s = (await sale(t.caissier!, tripA.id).expect(201)).body;
      const d = decodeTicketQr(s.qr);
      const forged = Uint8Array.from(d.payloadBytes);
      forged[75] = (forged[75]! ^ 0x01) & 0xff; // modifie le prix
      const qr = encodeTicketQr(forged, d.signature);
      const keys = (await get(app, '/controle/cles', t.controleur).expect(200)).body as Json[];
      expect(nodeVerify(qr, keys.find((k) => k.id === d.payload.keyId)!.publicKey)).toBe(false);
      const res = (await scan(t.controleur!, { qr }).expect(200)).body;
      expect(res.result).toBe('signature_invalide');
      await get(app, `/billetterie/tickets/${s.id}`, dirA).expect(200);
    });
    it('un QR fabriqué avec une autre clé est refusé', async () => {
      const s = (await sale(t.caissier!, tripA.id).expect(201)).body;
      const d = decodeTicketQr(s.qr);
      const qr = encodeTicketQr(d.payloadBytes, new Uint8Array(64).fill(7));
      expect((await scan(t.controleur!, { qr }).expect(200)).body.result).toBe('signature_invalide');
    });
    it('une seule clé serveur active par compagnie, même avec des premières ventes simultanées', async () => {
      const C = await createTenant(app, sa, 'bic');
      const dirC = await tokenOf(app, C.adminEmail);
      const line = await mkLine(dirC);
      const trips = await Promise.all([1, 2, 3].map(() => mkTrip(dirC, line.id)));
      const res = await Promise.all(trips.map((tr) => send(app, 'post', '/billetterie/ventes', dirC, { ticketId: randomUUID(), tripId: tr.id, fromStopId: line.o, toStopId: line.b, payment: { method: 'especes' } })));
      expect(res.map((r) => r.status)).toEqual([201, 201, 201]);
      const pool = adminPool();
      const rows = (await pool.query("SELECT public_key, private_key_enc FROM signing_keys WHERE tenant_id = $1 AND kind = 'serveur'", [C.tenantId])).rows;
      await pool.end();
      expect(rows).toHaveLength(1);
      expect(rows[0].public_key).toHaveLength(43);
      expect(Buffer.from(rows[0].private_key_enc, 'base64')).toHaveLength(12 + 16 + 48); // iv + tag + clé PKCS8 chiffrée
    });
  });

  describe('validation au contrôle', () => {
    it('valide une fois ; la seconde présentation est refusée avec l\'heure de la première', async () => {
      const s = (await sale(t.caissier!, tripA.id).expect(201)).body;
      const first = (await scan(t.controleur!, { qr: s.qr, tripId: tripA.id }).expect(200)).body;
      expect(first.result).toBe('valide');
      expect(first.ticket).toMatchObject({ number: s.number, seats: 1, from: 'Ouagadougou', to: 'Bobo-Dioulasso' });
      const second = (await scan(t.controleur!, { qr: s.qr }).expect(200)).body;
      expect(second.result).toBe('deja_valide');
      expect(second.firstValidatedAt).toBe(first.firstValidatedAt);
      expect((await get(app, `/billetterie/tickets/${s.id}`, dirA).expect(200)).body.status).toBe('valide');
    });
    it('saisie manuelle du numéro en secours', async () => {
      const s = (await sale(t.caissier!, tripA.id).expect(201)).body;
      expect((await scan(t.controleur!, { number: s.number }).expect(200)).body.result).toBe('valide');
      expect((await scan(t.controleur!, { number: 99999999 }).expect(200)).body.result).toBe('inconnu');
    });
    it('refuse un billet d\'un autre départ ; ne le consomme pas', async () => {
      const other = await mkTrip(dirA, lineA.id);
      const s = (await sale(t.caissier!, tripA.id).expect(201)).body;
      expect((await scan(t.controleur!, { qr: s.qr, tripId: other.id }).expect(200)).body.result).toBe('mauvais_depart');
      expect((await scan(t.controleur!, { qr: s.qr, tripId: tripA.id }).expect(200)).body.result).toBe('valide');
    });
    it('QR illisible, et corps invalide (400)', async () => {
      expect((await scan(t.controleur!, { qr: 'ceci-n-est-pas-un-qr-valide-du-tout' }).expect(200)).body.result).toBe('illisible');
      await scan(t.controleur!, {}).expect(400);
      await scan(t.controleur!, { qr: 'x'.repeat(30), number: 3 }).expect(400);
    });
    it('présentations simultanées d\'un même billet : une seule est valide', async () => {
      const s = (await sale(t.caissier!, tripA.id).expect(201)).body;
      const res = await Promise.all(Array.from({ length: 6 }, () => scan(t.controleur!, { qr: s.qr })));
      const results = res.map((r) => r.body.result);
      expect(results.filter((r) => r === 'valide')).toHaveLength(1);
      expect(results.filter((r) => r === 'deja_valide')).toHaveLength(5);
    });
    it('journalise chaque présentation', async () => {
      const s = (await sale(t.caissier!, tripA.id).expect(201)).body;
      await scan(t.controleur!, { qr: s.qr }).expect(200);
      await scan(t.controleur!, { qr: s.qr }).expect(200);
      const pool = adminPool();
      const rows = (await pool.query('SELECT result FROM validations WHERE ticket_id = $1 ORDER BY id', [s.id])).rows.map((r) => r.result);
      await pool.end();
      expect(rows).toEqual(['valide', 'deja_valide']);
    });
    it('état du départ pour le contrôleur', async () => {
      const trip = await mkTrip(dirA, lineA.id, 20);
      const a = (await sale(t.caissier!, trip.id, { seats: 2 }).expect(201)).body;
      await sale(t.caissier!, trip.id, { seats: 3 }).expect(201);
      const c = (await sale(t.caissier!, trip.id).expect(201)).body;
      await send(app, 'post', `/billetterie/tickets/${c.id}/annulation`, dirA, { reason: 'Billet perdu et remplacé' }).expect(200);
      await scan(t.controleur!, { qr: a.qr }).expect(200);
      const m = (await get(app, `/controle/departs/${trip.id}`, t.controleur).expect(200)).body;
      expect(m).toMatchObject({ seatsSold: 5, seatsValidated: 2, seatsNotYetValidated: 3, ticketsSold: 2 });
      expect(m.trip.seats).toBe(20);
    });
  });

  describe('annulation avec justification', () => {
    it('annule, rembourse, journalise ; refuse les doubles annulations et les billets validés', async () => {
      const s = (await sale(t.caissier!, tripA.id, { payment: { method: 'orange_money', reference: `OM-${uid()}` } }).expect(201)).body;
      await send(app, 'post', `/billetterie/tickets/${s.id}/annulation`, dirA, { reason: 'ok' }).expect(400);
      const res = (await send(app, 'post', `/billetterie/tickets/${s.id}/annulation`, dirA, { reason: 'Voyage annulé par le client' }).expect(200)).body;
      expect(res).toMatchObject({ status: 'annule', cancelReason: 'Voyage annulé par le client', payment: { status: 'rembourse' } });
      await send(app, 'post', `/billetterie/tickets/${s.id}/annulation`, dirA, { reason: 'Encore une fois' }).expect(409);
      expect((await scan(t.controleur!, { qr: s.qr }).expect(200)).body.result).toBe('annule');

      const v = (await sale(t.caissier!, tripA.id).expect(201)).body;
      await scan(t.controleur!, { qr: v.qr }).expect(200);
      await send(app, 'post', `/billetterie/tickets/${v.id}/annulation`, dirA, { reason: 'Trop tard pour annuler' }).expect(409);

      const pool = adminPool();
      const log = (await pool.query("SELECT user_id, after FROM audit_logs WHERE object_id = $1 AND action = 'ticket.cancelled'", [s.id])).rows;
      await pool.end();
      expect(log).toHaveLength(1);
      expect(log[0].after.reason).toBe('Voyage annulé par le client');
    });
  });

  describe('consultation', () => {
    it('filtre les billets par départ, numéro et statut, avec pagination', async () => {
      const trip = await mkTrip(dirA, lineA.id, 20);
      const made = [] as Json[];
      for (let i = 0; i < 4; i++) made.push((await sale(t.caissier!, trip.id).expect(201)).body);
      await send(app, 'post', `/billetterie/tickets/${made[0]!.id}/annulation`, dirA, { reason: 'Erreur de caisse' }).expect(200);
      const all = (await get(app, `/billetterie/tickets?tripId=${trip.id}`, t.caissier).expect(200)).body;
      expect(all.total).toBe(4);
      expect(all.items.map((x: Json) => x.number)).toEqual(made.map((x) => x.number).reverse());
      expect((await get(app, `/billetterie/tickets?tripId=${trip.id}&status=annule`, dirA).expect(200)).body.total).toBe(1);
      expect((await get(app, `/billetterie/tickets?number=${made[2]!.number}`, dirA).expect(200)).body.items[0].id).toBe(made[2]!.id);
      expect((await get(app, `/billetterie/tickets?tripId=${trip.id}&limit=3&offset=3`, dirA).expect(200)).body.items).toHaveLength(1);
    });
  });

  describe('isolation entre compagnies', () => {
    it('B ne voit, ne valide, ne vend ni n\'annule rien de A ; chaque compagnie a sa numérotation', async () => {
      const s = (await sale(t.caissier!, tripA.id).expect(201)).body;
      const ctrlB = await tokenOf(app, (await createStaff(app, dirB, 'controleur')).email);
      const cashB = await tokenOf(app, (await createStaff(app, dirB, 'caissier')).email);

      await get(app, `/billetterie/tickets/${s.id}`, dirB).expect(404);
      await send(app, 'post', `/billetterie/tickets/${s.id}/annulation`, dirB, { reason: 'Tentative de piratage' }).expect(404);
      await sale(cashB, tripA.id).expect(404);
      expect((await scan(ctrlB, { qr: s.qr }).expect(200)).body.result).toBe('inconnu');
      await get(app, `/controle/departs/${tripA.id}`, ctrlB).expect(404);
      const listB = (await get(app, '/billetterie/tickets?limit=100', dirB).expect(200)).body;
      expect(listB.items.map((x: Json) => x.id)).not.toContain(s.id);
      expect((await get(app, `/billetterie/tickets/${s.id}`, dirA).expect(200)).body.status).toBe('vendu');

      const lineB = await mkLine(dirB);
      const tripB = await mkTrip(dirB, lineB.id);
      const first = (await send(app, 'post', '/billetterie/ventes', cashB, { ticketId: randomUUID(), tripId: tripB.id, fromStopId: lineB.o, toStopId: lineB.b, payment: { method: 'especes' } }).expect(201)).body;
      expect(first.number).toBe(1);
      expect((await scan(ctrlB, { number: first.number }).expect(200)).body.ticket.number).toBe(1);
      const stopOfA = await send(app, 'post', '/billetterie/ventes', cashB, { ticketId: randomUUID(), tripId: tripB.id, fromStopId: O, toStopId: B, payment: { method: 'especes' } });
      expect(stopOfA.status).toBe(422);
      const keysB = (await get(app, '/controle/cles', ctrlB).expect(200)).body as Json[];
      const keysA = (await get(app, '/controle/cles', t.controleur).expect(200)).body as Json[];
      expect(keysB.map((k) => k.id).some((id) => keysA.map((x) => x.id).includes(id))).toBe(false);
    });
  });

  describe('garanties de la base de données', () => {
    it('un billet vendu est immuable ; pas de retour en arrière de statut ; pas de suppression', async () => {
      const s = (await sale(t.caissier!, tripA.id).expect(201)).body;
      const pool = adminPool();
      await expect(pool.query("UPDATE tickets SET qr = 'x' WHERE id = $1", [s.id])).rejects.toThrow(/immuable/);
      await expect(pool.query('UPDATE tickets SET seats = 9 WHERE id = $1', [s.id])).rejects.toThrow(/immuable/);
      await send(app, 'post', `/billetterie/tickets/${s.id}/annulation`, dirA, { reason: 'Test de retour arrière' }).expect(200);
      await expect(pool.query("UPDATE tickets SET status = 'vendu' WHERE id = $1", [s.id])).rejects.toThrow(/statut/);
      await pool.end();
      const app2 = appPool();
      await expect(app2.query('DELETE FROM tickets')).rejects.toThrow(/permission denied/);
      await expect(app2.query('DELETE FROM payments')).rejects.toThrow(/permission denied/);
      await app2.end();
    });
  });
});
