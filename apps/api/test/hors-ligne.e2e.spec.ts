import { randomUUID, createPublicKey, verify } from 'crypto';
import type { AddressInfo } from 'net';
import { INestApplication } from '@nestjs/common';
import { IDBFactory } from 'fake-indexeddb';
import { decodeTicketQr, encodeTicketQr, fromBase64Url, packTicketPayload } from '@transport/shared';
import {
  HttpTransport, NetworkError, OfflineEngine, OfflineError, Transport, generateKeyPair, signBytes,
} from '@transport/offline';
import { adminPool, createStaff, createTenant, createTestApp, get, send, superToken, tokenOf, uid } from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const HOUR = 3600 * 1000;
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const WINDOW = { from: '2026-12-01T00:00:00.000Z', to: '2028-01-01T00:00:00.000Z' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Réseau simulé : coupure totale, ou réponse perdue après traitement par le serveur. */
class Flaky implements Transport {
  down = false;
  dropResponse = new Set<keyof Transport>();
  constructor(private readonly inner: Transport) {}
  private async via<T>(name: keyof Transport, fn: () => Promise<T>): Promise<T> {
    if (this.down) throw new NetworkError('hors ligne');
    const r = await fn();
    if (this.dropResponse.delete(name)) throw new NetworkError('réponse perdue');
    return r;
  }
  requestDevice: Transport['requestDevice'] = (a) => this.via('requestDevice', () => this.inner.requestDevice(a));
  deviceState: Transport['deviceState'] = (a) => this.via('deviceState', () => this.inner.deviceState(a));
  reserveRange: Transport['reserveRange'] = (a, b) => this.via('reserveRange', () => this.inner.reserveRange(a, b));
  catalog: Transport['catalog'] = (a) => this.via('catalog', () => this.inner.catalog(a));
  controlData: Transport['controlData'] = (a) => this.via('controlData', () => this.inner.controlData(a));
  syncSales: Transport['syncSales'] = (a) => this.via('syncSales', () => this.inner.syncSales(a));
  syncValidations: Transport['syncValidations'] = (a) => this.via('syncValidations', () => this.inner.syncValidations(a));
}

describe('Mode hors ligne : moteur sur appareil simulé contre la vraie API', () => {
  let app: INestApplication;
  let base: string;
  let sa: string;
  let day = 0;
  const nextAt = () => new Date(Date.UTC(2027, 0, 1 + day++, 8)).toISOString();

  interface World { dir: string; caissier: string; controleur: string; tenantId: string; line: { id: string; o: string; k: string; b: string } }
  const world = async (label: string): Promise<World> => {
    const T = await createTenant(app, sa, label);
    const dir = await tokenOf(app, T.adminEmail);
    const caissier = await tokenOf(app, (await createStaff(app, dir, 'caissier')).email);
    const controleur = await tokenOf(app, (await createStaff(app, dir, 'controleur')).email);
    const l = (await send(app, 'post', '/lignes', dir, { code: `H${uid().toUpperCase()}`, name: 'Ouaga - Bobo', stops: ['Ouagadougou', 'Koudougou', 'Bobo-Dioulasso'] }).expect(201)).body;
    const [o, k, b] = l.stops.map((s: Json) => s.id as string);
    for (const [category, price] of [['plein_tarif', 8000], ['enfant', 4000]] as const) {
      await send(app, 'put', `/lignes/${l.id}/tarifs`, dir, { fromStopId: o, toStopId: b, category, price }).expect(200);
    }
    return { dir, caissier, controleur, tenantId: T.tenantId, line: { id: l.id, o: o!, k: k!, b: b! } };
  };
  const mkTrip = async (w: World, seats = 40) => (await send(app, 'post', '/departs', w.dir, { lineId: w.line.id, departureAt: nextAt(), seats }).expect(201)).body as Json;

  interface Device { eng: OfflineEngine; net: Flaky; id: string; clock: { offset: number }; idb: IDBFactory; token: string }
  const provision = async (w: World, kind: 'vente' | 'controle', opts: { skewMs?: number; rangeSize?: number; activate?: boolean; refresh?: boolean } = {}): Promise<Device> => {
    const token = kind === 'vente' ? w.caissier : w.controleur;
    const net = new Flaky(new HttpTransport(base, () => token));
    const clock = { offset: opts.skewMs ?? 0 };
    const idb = new IDBFactory();
    const eng = new OfflineEngine({ transport: net, idb, dbName: 'poste', now: () => Date.now() + clock.offset, rangeSize: opts.rangeSize ?? 5, referenceWindow: () => WINDOW });
    await eng.init(`Poste ${uid()}`, kind);
    const reg = await eng.register();
    if (opts.activate !== false) {
      await send(app, 'post', `/postes/${reg.deviceId}/activation`, w.dir, {}).expect(200);
      await eng.refreshDevice();
      if (opts.refresh !== false) {
        await eng.refreshReference();
        if (kind === 'vente') await eng.ensureRange();
      }
    }
    return { eng, net, id: reg.deviceId!, clock, idb, token };
  };
  const ticketOf = async (w: World, id: string) => (await get(app, `/billetterie/tickets/${id}`, w.dir).expect(200)).body as Json;
  const anomalies = async (w: World, kind: string) => (await get(app, `/anomalies?kind=${kind}&limit=100`, w.dir).expect(200)).body.items as Json[];
  const nodeVerify = (qr: string, publicKeyB64: string) => {
    const d = decodeTicketQr(qr);
    const key = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(fromBase64Url(publicKeyB64))]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(d.payloadBytes), key, Buffer.from(d.signature));
  };
  const sellInput = (w: World, trip: Json, over: Json = {}) => ({ tripId: trip.id as string, fromStopId: w.line.o, toStopId: w.line.b, payment: { method: 'especes' as const }, ...over });

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    sa = await superToken(app);
  });
  afterAll(async () => app.close());

  describe('postes : demande, activation, révocation', () => {
    it('le poste demande son activation, un administrateur l\'active, une clé de signature lui est attribuée', async () => {
      const w = await world('act');
      const d = await provision(w, 'vente', { activate: false });
      expect(d.eng).toBeDefined();
      expect((await d.eng.status()).canSell).toBe(false);
      expect((await d.eng.refreshDevice()).status).toBe('en_attente');

      const list = (await get(app, '/postes', w.dir).expect(200)).body as Json[];
      expect(list.find((x) => x.id === d.id)).toMatchObject({ status: 'en_attente', kind: 'vente', signingKeyId: null });
      await get(app, '/postes', w.caissier).expect(403);
      await send(app, 'post', `/postes/${d.id}/activation`, w.caissier, {}).expect(403);

      await send(app, 'post', `/postes/${d.id}/activation`, w.dir, {}).expect(200);
      await send(app, 'post', `/postes/${d.id}/activation`, w.dir, {}).expect(409);
      const id = await d.eng.refreshDevice();
      expect(id).toMatchObject({ status: 'actif', tenantId: w.tenantId });
      expect(id.signingKeyId).toBeTruthy();
      const keys = (await get(app, '/controle/cles', w.controleur).expect(200)).body as Json[];
      expect(keys.find((k) => k.id === id.signingKeyId)).toMatchObject({ kind: 'poste', status: 'actif' });
    });
    it('la demande est rejouable et refuse les droits insuffisants', async () => {
      const w = await world('req');
      const d = await provision(w, 'vente', { activate: false });
      expect((await d.eng.register()).deviceId).toBe(d.id);
      const kp = await generateKeyPair();
      await send(app, 'post', '/postes/demandes', w.caissier, { name: 'Faux contrôle', kind: 'controle', publicKey: kp.publicKey }).expect(403);
      await send(app, 'post', '/postes/demandes', w.controleur, { name: 'Faux vente', kind: 'vente', publicKey: kp.publicKey }).expect(403);
      await send(app, 'post', '/postes/demandes', w.caissier, { name: 'Clé invalide', kind: 'vente', publicKey: 'trop-court' }).expect(400);
      await send(app, 'post', '/postes/demandes', w.caissier, { name: 'Mauvais type', kind: 'camion', publicKey: kp.publicKey }).expect(400);
    });
    it('un poste non activé ne peut ni synchroniser ni réserver de numéros', async () => {
      const w = await world('nact');
      const d = await provision(w, 'vente', { activate: false });
      const body = { deviceId: d.id, deviceNow: new Date().toISOString(), sales: [] };
      expect((await send(app, 'post', '/billetterie/synchronisation', w.caissier, body).expect(403)).body.code).toBe('poste_non_active');
      await send(app, 'post', `/postes/${d.id}/plages`, w.caissier, { size: 5 }).expect(403);
    });
  });

  describe('vente hors ligne et synchronisation', () => {
    it('vend sans réseau avec des QR signés par le poste, puis synchronise sans perte ni doublon', async () => {
      const w = await world('vte');
      const trip = await mkTrip(w);
      const d = await provision(w, 'vente');
      d.net.down = true;
      const sold = [] as Awaited<ReturnType<OfflineEngine['sellOffline']>>[];
      for (let i = 0; i < 3; i++) sold.push(await d.eng.sellOffline(sellInput(w, trip, { seats: 1 })));
      expect(sold.map((s) => s.number)).toEqual([sold[0]!.number, sold[0]!.number + 1, sold[0]!.number + 2]);
      expect(sold[0]).toMatchObject({ unitPrice: 8000, total: 8000 });
      expect(await d.eng.status()).toMatchObject({ pendingSales: 3, canSell: true });

      const idState = await d.eng.refreshDevice().catch(() => d.eng.init('x', 'vente'));
      void idState;
      const sync1 = await d.eng.sync();
      expect(sync1).toMatchObject({ ok: false, reason: 'reseau' });
      expect((await d.eng.status()).pendingSales).toBe(3);

      d.net.down = false;
      expect(await d.eng.sync()).toMatchObject({ ok: true, sent: 3, rejected: 0 });
      expect(await d.eng.sync()).toMatchObject({ ok: true, sent: 0 });
      for (const s of sold) {
        const t = await ticketOf(w, s.ticketId);
        expect(t).toMatchObject({ number: s.number, status: 'vendu', offline: true, deviceId: d.id, total: 8000, payment: { method: 'especes', status: 'encaisse' } });
      }
      // Vérifiable avec la clé publique du poste, indépendamment du moteur
      const keys = (await get(app, '/controle/cles', w.controleur).expect(200)).body as Json[];
      const key = keys.find((k) => k.kind === 'poste')!;
      expect(nodeVerify(sold[0]!.qr, key.publicKey)).toBe(true);
      // Un billet vendu hors ligne se valide en ligne comme les autres
      const scan = (await send(app, 'post', '/controle/validations', w.controleur, { qr: sold[0]!.qr }).expect(200)).body;
      expect(scan.result).toBe('valide');
      const dispo = (await get(app, `/billetterie/departs?lineId=${w.line.id}&limit=100`, w.caissier).expect(200)).body.items.find((x: Json) => x.id === trip.id);
      expect(dispo.sold).toBe(3);
    });

    it('paiement mobile saisi hors ligne : « à vérifier » jusqu\'à confirmation par le directeur', async () => {
      const w = await world('mm');
      const trip = await mkTrip(w);
      const d = await provision(w, 'vente');
      const s = await d.eng.sellOffline(sellInput(w, trip, { payment: { method: 'orange_money', reference: `OM-${uid()}` } }));
      await d.eng.sync();
      expect((await ticketOf(w, s.ticketId)).payment.status).toBe('a_verifier');
      await send(app, 'post', `/billetterie/tickets/${s.ticketId}/paiement-verifie`, w.caissier, {}).expect(403);
      expect((await send(app, 'post', `/billetterie/tickets/${s.ticketId}/paiement-verifie`, w.dir, {}).expect(200)).body.payment.status).toBe('encaisse');
      await send(app, 'post', `/billetterie/tickets/${s.ticketId}/paiement-verifie`, w.dir, {}).expect(409);
    });

    it('la synchronisation interrompue (réponse perdue) est rejouable sans doublon', async () => {
      const w = await world('rej');
      const trip = await mkTrip(w);
      const d = await provision(w, 'vente');
      const a = await d.eng.sellOffline(sellInput(w, trip));
      const b = await d.eng.sellOffline(sellInput(w, trip));
      d.net.dropResponse.add('syncSales');
      expect(await d.eng.sync()).toMatchObject({ ok: false, reason: 'reseau' });
      expect((await d.eng.status()).pendingSales).toBe(2);
      expect(await d.eng.sync()).toMatchObject({ ok: true, sent: 2, rejected: 0 });
      const pool = adminPool();
      const n = (await pool.query('SELECT count(*) AS n FROM tickets WHERE id = ANY($1)', [[a.ticketId, b.ticketId]])).rows[0].n;
      await pool.end();
      expect(Number(n)).toBe(2);
    });

    it('survit à un redémarrage de l\'appareil : identité, ventes en attente et numéros restants conservés', async () => {
      const w = await world('rst');
      const trip = await mkTrip(w);
      const d = await provision(w, 'vente', { rangeSize: 10 });
      await d.eng.sellOffline(sellInput(w, trip));
      await d.eng.sellOffline(sellInput(w, trip));
      const before = await d.eng.init('ignoré', 'vente');
      const reborn = new OfflineEngine({ transport: d.net, idb: d.idb, dbName: 'poste', now: () => Date.now(), rangeSize: 10, referenceWindow: () => WINDOW });
      const after = await reborn.init('autre nom', 'vente');
      expect(after.publicKey).toBe(before.publicKey);
      expect(after.deviceId).toBe(d.id);
      expect(await reborn.status()).toMatchObject({ pendingSales: 2, rangeRemaining: 8, canSell: true });
      expect(await reborn.sync()).toMatchObject({ ok: true, sent: 2 });
    });

    it('limite locale de places : le poste ne vend pas plus que ce qu\'il sait disponible', async () => {
      const w = await world('loc');
      const trip = await mkTrip(w, 2);
      const d = await provision(w, 'vente');
      await d.eng.sellOffline(sellInput(w, trip, { seats: 2 }));
      await expect(d.eng.sellOffline(sellInput(w, trip))).rejects.toMatchObject({ code: 'plus_de_places' });
      await expect(d.eng.sellOffline(sellInput(w, trip, { fromStopId: w.line.b, toStopId: w.line.o }))).rejects.toMatchObject({ code: 'trajet_invalide' });
      await expect(d.eng.sellOffline(sellInput(w, trip, { category: 'etudiant' }))).rejects.toMatchObject({ code: 'tarif_absent' });
    });
  });

  describe('plages de numéros', () => {
    it('plage épuisée : vente bloquée ; nouvelle plage au rétablissement ; seuil de 20 %', async () => {
      const w = await world('plg');
      const trip = await mkTrip(w);
      const d = await provision(w, 'vente', { rangeSize: 5 });
      expect(await d.eng.ensureRange()).toBe(false); // 5 restants > 20 % de 5
      for (let i = 0; i < 4; i++) await d.eng.sellOffline(sellInput(w, trip));
      expect(await d.eng.status()).toMatchObject({ rangeRemaining: 1, needsRange: true });
      d.net.down = true;
      expect(await d.eng.ensureRange()).toBe(false); // sans réseau : on continue sur la plage restante
      await d.eng.sellOffline(sellInput(w, trip));
      await expect(d.eng.sellOffline(sellInput(w, trip))).rejects.toBeInstanceOf(OfflineError);
      await expect(d.eng.sellOffline(sellInput(w, trip))).rejects.toMatchObject({ code: 'plage_epuisee' });
      expect(await d.eng.status()).toMatchObject({ canSell: false, blockedReason: 'plage_epuisee' });
      d.net.down = false;
      expect(await d.eng.ensureRange()).toBe(true);
      const s = await d.eng.sellOffline(sellInput(w, trip));
      expect(s.number).toBeGreaterThan(0);
      expect(await d.eng.sync()).toMatchObject({ ok: true, sent: 6, rejected: 0 });
    });
    it('jamais de chevauchement entre postes, même en réservations simultanées, ni avec les ventes en ligne', async () => {
      const w = await world('chv');
      const trip = await mkTrip(w);
      const devs = await Promise.all([1, 2, 3].map(() => provision(w, 'vente', { refresh: false })));
      await Promise.all(devs.flatMap((d) => [0, 1].map(() => send(app, 'post', `/postes/${d.id}/plages`, w.caissier, { size: 50 }).expect(201))));
      const online = (await send(app, 'post', '/billetterie/ventes', w.caissier, { ticketId: randomUUID(), tripId: trip.id, fromStopId: w.line.o, toStopId: w.line.b, payment: { method: 'especes' } }).expect(201)).body;
      const pool = adminPool();
      const ranges = (await pool.query('SELECT start_number AS s, end_number AS e FROM number_ranges WHERE tenant_id = $1 ORDER BY start_number', [w.tenantId])).rows as { s: number; e: number }[];
      await pool.end();
      expect(ranges).toHaveLength(6);
      for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.s).toBeGreaterThan(ranges[i - 1]!.e);
      expect(ranges.some((r) => online.number >= r.s && online.number <= r.e)).toBe(false);
    });
    it('règle des 48 h : plus de vente au-delà, reprise après reconnexion', async () => {
      const w = await world('48h');
      const trip = await mkTrip(w);
      const d = await provision(w, 'vente');
      d.net.down = true;
      d.clock.offset += 47 * HOUR;
      await d.eng.sellOffline(sellInput(w, trip));
      d.clock.offset += 2 * HOUR;
      await expect(d.eng.sellOffline(sellInput(w, trip))).rejects.toMatchObject({ code: 'hors_ligne_trop_long' });
      expect(await d.eng.status()).toMatchObject({ canSell: false, blockedReason: 'hors_ligne_trop_long' });
      d.net.down = false;
      await d.eng.refreshDevice();
      expect((await d.eng.status()).canSell).toBe(true);
      await d.eng.sellOffline(sellInput(w, trip));
    });
  });

  describe('révocation d\'un poste', () => {
    it('poste volé : synchronisation refusée, QR non synchronisés rejetés ; billets déjà synchronisés restent valables', async () => {
      const w = await world('rev');
      const trip = await mkTrip(w);
      const d = await provision(w, 'vente');
      const early = await d.eng.sellOffline(sellInput(w, trip));
      await d.eng.sync();
      const late = await d.eng.sellOffline(sellInput(w, trip));

      await send(app, 'post', `/postes/${d.id}/revocation`, w.dir, { reason: 'ok' }).expect(400);
      await send(app, 'post', `/postes/${d.id}/revocation`, w.caissier, { reason: 'Poste volé à la gare' }).expect(403);
      const rev = (await send(app, 'post', `/postes/${d.id}/revocation`, w.dir, { reason: 'Poste volé à la gare' }).expect(200)).body;
      expect(rev).toMatchObject({ status: 'revoque', revokeReason: 'Poste volé à la gare' });
      await send(app, 'post', `/postes/${d.id}/revocation`, w.dir, { reason: 'Encore une fois' }).expect(409);
      await send(app, 'post', `/postes/${d.id}/activation`, w.dir, {}).expect(409);

      expect(await d.eng.sync()).toMatchObject({ ok: false, reason: 'poste_revoque' });
      expect(await d.eng.status()).toMatchObject({ deviceStatus: 'revoque', canSell: false, pendingSales: 1 });
      await send(app, 'post', `/postes/${d.id}/plages`, w.caissier, { size: 5 }).expect(403);
      expect((await send(app, 'post', '/controle/validations', w.controleur, { qr: late.qr }).expect(200)).body.result).toBe('signature_invalide');
      expect((await send(app, 'post', '/controle/validations', w.controleur, { qr: early.qr }).expect(200)).body.result).toBe('valide');
      expect((await get(app, `/billetterie/tickets/${late.ticketId}`, w.dir)).status).toBe(404);
    });
  });

  describe('synchronisation hostile : ventes falsifiées', () => {
    const rawDevice = async (w: World) => {
      const kp = await generateKeyPair();
      const req = (await send(app, 'post', '/postes/demandes', w.caissier, { name: 'Poste brut', kind: 'vente', publicKey: kp.publicKey }).expect(201)).body;
      await send(app, 'post', `/postes/${req.id}/activation`, w.dir, {}).expect(200);
      const range = (await send(app, 'post', `/postes/${req.id}/plages`, w.caissier, { size: 10 }).expect(201)).body as { start: number; end: number };
      const state = (await get(app, `/postes/${req.id}/etat`, w.caissier).expect(200)).body as Json;
      return { id: req.id as string, kp, range, keyId: state.signingKeyId as string, tenantId: state.tenantId as string };
    };
    type Raw = Awaited<ReturnType<typeof rawDevice>>;
    const forge = async (d: Raw, w: World, trip: Json, o: { body?: Json; qr?: Json; signWith?: string } = {}) => {
      const ticketId = (o.body?.ticketId as string) ?? randomUUID();
      const number = (o.body?.number as number) ?? d.range.start;
      const total = (o.body?.total as number) ?? 8000;
      const seats = (o.body?.seats as number) ?? 1;
      const payload = packTicketPayload({
        version: 1, tenantId: d.tenantId, keyId: d.keyId, ticketId, number, tripId: trip.id, departureAt: Math.floor(Date.parse(trip.departureAt) / 1000), price: total, seats, ...(o.qr ?? {}),
      });
      const qr = encodeTicketQr(payload, await signBytes(o.signWith ?? d.kp.privateKey, payload));
      return { ticketId, number, tripId: trip.id, fromStopId: w.line.o, toStopId: w.line.b, category: 'plein_tarif', seats, total, payment: { method: 'especes' }, soldAt: new Date().toISOString(), qr, ...(o.body ?? {}) };
    };
    const push = (d: Raw, w: World, sales: Json[]) =>
      send(app, 'post', '/billetterie/synchronisation', w.caissier, { deviceId: d.id, deviceNow: new Date().toISOString(), sales });

    it('rejette chaque tentative de fraude avec sa raison, sans empêcher les ventes honnêtes du même lot', async () => {
      const w = await world('frd');
      const trip = await mkTrip(w);
      const other = await world('frd2');
      const d = await rawDevice(w);
      const other2 = await rawDevice(w);
      const n = d.range.start;
      const good = await forge(d, w, trip, { body: { number: n } });
      const cases: [string, Json][] = [
        ['numero_hors_plage', await forge(d, w, trip, { body: { number: d.range.end + 100 } })],
        ['signature_invalide', await forge(d, w, trip, { body: { number: n + 1 }, signWith: other2.kp.privateKey })],
        ['qr_incoherent', await forge(d, w, trip, { body: { number: n + 2 }, qr: { price: 100 } })],
        ['depart_inconnu', await forge(d, w, { ...trip, id: randomUUID() }, { body: { number: n + 3 } })],
        ['montant_invalide', await forge(d, w, trip, { body: { number: n + 4, seats: 2, total: 8001 } })],
        ['arrets_invalides', { ...(await forge(d, w, trip, { body: { number: n + 5 } })), fromStopId: other.line.o }],
        ['qr_illisible', { ...(await forge(d, w, trip, { body: { number: n + 6 } })), qr: 'x'.repeat(40) }],
      ];
      const res = (await push(d, w, [good, ...cases.map(([, s]) => s)]).expect(200)).body.results as Json[];
      expect(res[0]).toMatchObject({ result: 'ok' });
      cases.forEach(([reason], i) => expect(res[i + 1]).toMatchObject({ result: 'rejete', reason }));
      const kinds = (await anomalies(w, 'vente_rejetee')).map((a) => a.detail.reason);
      for (const [reason] of cases) expect(kinds).toContain(reason);
      expect((await ticketOf(w, good.ticketId)).offline).toBe(true);
    });
    it('un numéro déjà pris ou un identifiant déjà utilisé par un autre poste est rejeté', async () => {
      const w = await world('dup');
      const trip = await mkTrip(w);
      const a = await rawDevice(w);
      const b = await rawDevice(w);
      const first = await forge(a, w, trip, { body: { number: a.range.start } });
      expect((await push(a, w, [first]).expect(200)).body.results[0].result).toBe('ok');
      expect((await push(a, w, [first]).expect(200)).body.results[0].result).toBe('deja_synchronise');
      const sameNumber = await forge(a, w, trip, { body: { number: a.range.start } });
      expect((await push(a, w, [sameNumber]).expect(200)).body.results[0]).toMatchObject({ result: 'rejete', reason: 'numero_deja_utilise' });
      const stolenId = await forge(b, w, trip, { body: { ticketId: first.ticketId, number: b.range.start } });
      expect((await push(b, w, [stolenId]).expect(200)).body.results[0]).toMatchObject({ result: 'rejete', reason: 'identifiant_deja_utilise' });
    });
    it('un poste de contrôle ne peut pas envoyer de ventes, un poste de vente pas de validations', async () => {
      const w = await world('typ');
      const ctrl = await provision(w, 'controle');
      const v = await provision(w, 'vente');
      const now = new Date().toISOString();
      expect((await send(app, 'post', '/billetterie/synchronisation', w.caissier, { deviceId: ctrl.id, deviceNow: now, sales: [] }).expect(403)).body.code).toBe('poste_type_invalide');
      expect((await send(app, 'post', '/controle/synchronisation', w.controleur, { deviceId: v.id, deviceNow: now, validations: [] }).expect(403)).body.code).toBe('poste_type_invalide');
      await send(app, 'post', '/controle/synchronisation', w.caissier, { deviceId: ctrl.id, deviceNow: now, validations: [] }).expect(403);
    });
  });

  describe('anomalies signalées sans bloquer la vente', () => {
    it('surréservation : deux postes hors ligne vendent les dernières places', async () => {
      const w = await world('sur');
      const trip = await mkTrip(w, 2);
      const a = await provision(w, 'vente');
      const b = await provision(w, 'vente');
      await a.eng.sellOffline(sellInput(w, trip, { seats: 2 }));
      await b.eng.sellOffline(sellInput(w, trip, { seats: 2 }));
      expect(await a.eng.sync()).toMatchObject({ ok: true, sent: 1, anomalies: [] });
      const rb = await b.eng.sync();
      expect(rb).toMatchObject({ ok: true, sent: 1, anomalies: ['surreservation'] });
      const list = await anomalies(w, 'surreservation');
      expect(list).toHaveLength(1);
      expect(list[0]!.detail).toMatchObject({ capacite: 2, placesApresCetteVente: 4 });
      const controle = (await get(app, `/controle/departs/${trip.id}`, w.controleur).expect(200)).body;
      expect(controle.seatsSold).toBe(4);
    });
    it('départ annulé et tarif modifié entre-temps', async () => {
      const w = await world('ecr');
      const t1 = await mkTrip(w);
      const t2 = await mkTrip(w);
      const d = await provision(w, 'vente');
      d.net.down = true;
      await send(app, 'patch', `/departs/${t1.id}`, w.dir, { status: 'annule' }).expect(200);
      await send(app, 'put', `/lignes/${w.line.id}/tarifs`, w.dir, { fromStopId: w.line.o, toStopId: w.line.b, price: 9000 }).expect(200);
      const a = await d.eng.sellOffline(sellInput(w, t1));
      const b = await d.eng.sellOffline(sellInput(w, t2));
      d.net.down = false;
      expect(await d.eng.sync()).toMatchObject({ ok: true, sent: 2, rejected: 0 });
      expect((await anomalies(w, 'depart_annule')).map((x) => x.ticketId)).toContain(a.ticketId);
      const ecart = (await anomalies(w, 'ecart_tarif')).find((x) => x.ticketId === b.ticketId)!;
      expect(ecart.detail).toMatchObject({ prixAttendu: 9000, prixRecu: 8000 });
      expect((await ticketOf(w, b.ticketId)).total).toBe(8000); // le client a payé 8000 : le billet est conservé tel quel
    });
    it('référence de paiement mobile déjà utilisée', async () => {
      const w = await world('ref');
      const trip = await mkTrip(w);
      const d = await provision(w, 'vente');
      const ref = `MM-${uid()}`;
      await send(app, 'post', '/billetterie/ventes', w.caissier, { ticketId: randomUUID(), tripId: trip.id, fromStopId: w.line.o, toStopId: w.line.b, payment: { method: 'moov_money', reference: ref } }).expect(201);
      const s = await d.eng.sellOffline(sellInput(w, trip, { payment: { method: 'moov_money', reference: ref } }));
      expect(await d.eng.sync()).toMatchObject({ ok: true, anomalies: ['reference_dupliquee'] });
      expect((await ticketOf(w, s.ticketId)).payment.status).toBe('a_verifier');
    });
    it('horloge de l\'appareil très décalée : heure de vente corrigée et anomalie', async () => {
      const w = await world('hor');
      const trip = await mkTrip(w);
      const d = await provision(w, 'vente', { skewMs: 30 * HOUR });
      const s = await d.eng.sellOffline(sellInput(w, trip));
      await d.eng.sync();
      const t = await ticketOf(w, s.ticketId);
      expect(Math.abs(Date.parse(t.soldAt) - Date.now())).toBeLessThan(60_000);
      expect((await anomalies(w, 'horloge_decalee')).length).toBeGreaterThan(0);
    });
    it('rapport d\'anomalies : réservé au directeur, résumé, traitement', async () => {
      const w = await world('rap');
      const trip = await mkTrip(w, 1);
      const a = await provision(w, 'vente');
      const b = await provision(w, 'vente');
      await a.eng.sellOffline(sellInput(w, trip));
      await b.eng.sellOffline(sellInput(w, trip));
      await a.eng.sync();
      await b.eng.sync();
      await get(app, '/anomalies', w.caissier).expect(403);
      await get(app, '/anomalies/resume', w.controleur).expect(403);
      const resume = (await get(app, '/anomalies/resume', w.dir).expect(200)).body;
      expect(resume).toMatchObject({ open: 1, byKind: { surreservation: 1 }, pendingValidations: 0 });
      const [an] = await anomalies(w, 'surreservation');
      const done = (await send(app, 'patch', `/anomalies/${an!.id}`, w.dir, { note: 'Client remboursé' }).expect(200)).body;
      expect(done).toMatchObject({ status: 'traitee', note: 'Client remboursé' });
      expect((await get(app, '/anomalies?status=ouverte', w.dir).expect(200)).body.total).toBe(0);
      expect((await get(app, '/anomalies/resume', w.dir).expect(200)).body.open).toBe(0);
    });
  });

  describe('contrôle hors ligne', () => {
    const onlineSale = async (w: World, trip: Json) =>
      (await send(app, 'post', '/billetterie/ventes', w.caissier, { ticketId: randomUUID(), tripId: trip.id, fromStopId: w.line.o, toStopId: w.line.b, payment: { method: 'especes' } }).expect(201)).body as Json;

    it('valide sans réseau avec les clés emportées ; refuse doublon, faux, mauvais départ et billets d\'une autre compagnie', async () => {
      const w = await world('ctl');
      const trip = await mkTrip(w);
      const other = await mkTrip(w);
      const t1 = await onlineSale(w, trip);
      const t2 = await onlineSale(w, trip);
      const c = await provision(w, 'controle');
      c.net.down = true;
      const first = await c.eng.validateOffline({ qr: t1.qr, tripId: trip.id });
      expect(first).toMatchObject({ result: 'valide', ticket: { number: t1.number, seats: 1 } });
      expect(first.sousReserve).toBeUndefined();
      expect(await c.eng.validateOffline({ qr: t1.qr })).toMatchObject({ result: 'deja_valide' });
      expect(await c.eng.validateOffline({ qr: t2.qr, tripId: other.id })).toMatchObject({ result: 'mauvais_depart' });
      expect(await c.eng.validateOffline({ qr: 'pas-un-qr-lisible-du-tout-ici' })).toMatchObject({ result: 'illisible' });
      const d = decodeTicketQr(t2.qr);
      const forged = Uint8Array.from(d.payloadBytes);
      forged[75] = (forged[75]! ^ 1) & 0xff;
      expect(await c.eng.validateOffline({ qr: encodeTicketQr(forged, d.signature) })).toMatchObject({ result: 'signature_invalide' });
      const foreign = await world('ctl2');
      const ft = await mkTrip(foreign);
      const fticket = await onlineSale(foreign, ft);
      expect(await c.eng.validateOffline({ qr: fticket.qr })).toMatchObject({ result: 'inconnu' });
      expect(await c.eng.status()).toMatchObject({ pendingValidations: 1 });
      c.net.down = false;
      expect(await c.eng.sync()).toMatchObject({ ok: true, sent: 1 });
      expect((await ticketOf(w, t1.id))).toMatchObject({ status: 'valide' });
      expect((await ticketOf(w, t2.id)).status).toBe('vendu');
    });

    it('deux contrôleurs valident le même billet hors ligne : la première présentation est retenue, malgré une horloge décalée et un ordre d\'envoi inversé', async () => {
      const w = await world('dbl');
      const trip = await mkTrip(w);
      const t = await onlineSale(w, trip);
      const c1 = await provision(w, 'controle');
      const c2 = await provision(w, 'controle', { skewMs: 3 * HOUR });
      c1.net.down = true;
      c2.net.down = true;
      expect((await c1.eng.validateOffline({ qr: t.qr })).result).toBe('valide');
      await sleep(250);
      expect((await c2.eng.validateOffline({ qr: t.qr })).result).toBe('valide');
      const firstScan = (await c1.eng.listValidations())[0]!.scannedAt;
      c1.net.down = false;
      c2.net.down = false;
      expect(await c2.eng.sync()).toMatchObject({ ok: true, sent: 1 }); // le second contrôleur arrive en premier
      expect(await c1.eng.sync()).toMatchObject({ ok: true, sent: 1, anomalies: [] });
      const ticket = await ticketOf(w, t.id);
      expect(ticket.status).toBe('valide');
      expect(Math.abs(Date.parse(ticket.validatedAt) - Date.parse(firstScan))).toBeLessThan(1500);
      const pool = adminPool();
      const rows = (await pool.query('SELECT device_id, result FROM validations WHERE ticket_id = $1 ORDER BY id', [t.id])).rows;
      await pool.end();
      expect(rows.find((r) => r.device_id === c1.id).result).toBe('valide');
      expect(rows.find((r) => r.device_id === c2.id).result).toBe('doublon');
      expect(await anomalies(w, 'validation_doublon')).toHaveLength(1);
    });

    it('billet vendu hors ligne et validé avant sa synchronisation : validation mise en attente puis rattachée', async () => {
      const w = await world('att');
      const trip = await mkTrip(w);
      const v = await provision(w, 'vente');
      const c = await provision(w, 'controle'); // emporte la clé du poste de vente, pas ses billets
      const s = await v.eng.sellOffline(sellInput(w, trip));
      const scan = await c.eng.validateOffline({ qr: s.qr, tripId: trip.id });
      expect(scan).toMatchObject({ result: 'valide', sousReserve: true });
      const scannedAt = (await c.eng.listValidations())[0]!.scannedAt;
      expect(await c.eng.sync()).toMatchObject({ ok: true, sent: 1 });
      expect((await c.eng.listValidations())[0]!.serverResult).toBe('en_attente');
      expect((await get(app, '/anomalies/resume', w.dir).expect(200)).body.pendingValidations).toBe(1);

      expect(await v.eng.sync()).toMatchObject({ ok: true, sent: 1 });
      const ticket = await ticketOf(w, s.ticketId);
      expect(ticket.status).toBe('valide');
      expect(Math.abs(Date.parse(ticket.validatedAt) - Date.parse(scannedAt))).toBeLessThan(1500);
      expect((await get(app, '/anomalies/resume', w.dir).expect(200)).body.pendingValidations).toBe(0);
    });

    it('billet d\'un poste révoqué non synchronisé : refusé par un contrôleur qui a rechargé les clés', async () => {
      const w = await world('rv2');
      const trip = await mkTrip(w);
      const v = await provision(w, 'vente');
      const s = await v.eng.sellOffline(sellInput(w, trip));
      await send(app, 'post', `/postes/${v.id}/revocation`, w.dir, { reason: 'Poste volé en gare' }).expect(200);
      const c = await provision(w, 'controle');
      expect(await c.eng.validateOffline({ qr: s.qr })).toMatchObject({ result: 'signature_invalide' });
    });

    it('billet annulé après le chargement des données : refusé et signalé à la synchronisation', async () => {
      const w = await world('can');
      const trip = await mkTrip(w);
      const t = await onlineSale(w, trip);
      const c = await provision(w, 'controle');
      await send(app, 'post', `/billetterie/tickets/${t.id}/annulation`, w.dir, { reason: 'Client remboursé au guichet' }).expect(200);
      c.net.down = true;
      expect((await c.eng.validateOffline({ qr: t.qr })).result).toBe('valide'); // le poste l'ignore encore
      c.net.down = false;
      expect(await c.eng.sync()).toMatchObject({ ok: true, anomalies: ['annule'] });
      expect((await c.eng.listValidations())[0]!.serverResult).toBe('annule');
      expect(await anomalies(w, 'validation_billet_annule')).toHaveLength(1);
      expect((await ticketOf(w, t.id)).status).toBe('annule');
    });

    it('synchronisation des validations rejouable (réponse perdue) : une seule ligne par présentation', async () => {
      const w = await world('rjv');
      const trip = await mkTrip(w);
      const t = await onlineSale(w, trip);
      const c = await provision(w, 'controle');
      await c.eng.validateOffline({ qr: t.qr });
      c.net.dropResponse.add('syncValidations');
      expect(await c.eng.sync()).toMatchObject({ ok: false, reason: 'reseau' });
      expect(await c.eng.sync()).toMatchObject({ ok: true, sent: 1 });
      const pool = adminPool();
      const n = (await pool.query('SELECT count(*) AS n FROM validations WHERE ticket_id = $1', [t.id])).rows[0].n;
      await pool.end();
      expect(Number(n)).toBe(1);
      expect(await anomalies(w, 'validation_doublon')).toHaveLength(0);
    });
  });

  describe('droits et isolation entre compagnies', () => {
    it('référentiels réservés aux bons rôles', async () => {
      const w = await world('ref2');
      await get(app, `/billetterie/referentiel?from=${WINDOW.from}&to=${WINDOW.to}`, w.caissier).expect(200);
      await get(app, `/controle/referentiel?from=${WINDOW.from}&to=${WINDOW.to}`, w.controleur).expect(200);
      await get(app, '/billetterie/referentiel', w.controleur).expect(403);
      await get(app, '/controle/referentiel', w.caissier).expect(403);
    });
    it('une compagnie ne voit ni n\'utilise les postes, plages et anomalies d\'une autre', async () => {
      const A = await world('isa');
      const B = await world('isb');
      const tripA = await mkTrip(A);
      const da = await provision(A, 'vente');
      await da.eng.sellOffline(sellInput(A, tripA));
      const listB = (await get(app, '/postes', B.dir).expect(200)).body as Json[];
      expect(listB.map((x) => x.id)).not.toContain(da.id);
      await get(app, `/postes/${da.id}/etat`, B.caissier).expect(404);
      await send(app, 'post', `/postes/${da.id}/plages`, B.caissier, { size: 5 }).expect(404);
      await send(app, 'post', `/postes/${da.id}/revocation`, B.dir, { reason: 'Tentative de piratage' }).expect(404);
      await send(app, 'post', '/billetterie/synchronisation', B.caissier, { deviceId: da.id, deviceNow: new Date().toISOString(), sales: [] }).expect(404);
      expect((await get(app, '/anomalies?limit=100', B.dir).expect(200)).body.total).toBe(0);
      expect((await get(app, `/controle/referentiel?from=${WINDOW.from}&to=${WINDOW.to}`, B.controleur).expect(200)).body.tickets).toHaveLength(0);
    });
  });
});
