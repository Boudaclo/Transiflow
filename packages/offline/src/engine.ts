import {
  DeviceKind, FareCategory, PaymentMethod, QR_VERSION, decodeTicketQr, encodeTicketQr, packTicketPayload,
} from '@transport/shared';
import { generateKeyPair, newUuid, signBytes, verifyBytes } from './keys';
import { OfflineStore } from './store';
import {
  ApiError, CachedTicket, CatalogResponse, DeviceIdentity, NetworkError, OfflineError, PublicKeyInfo,
  RangeRecord, RefTrip, StoredSale, StoredValidation, Transport,
} from './types';

const HOUR = 3600 * 1000;
export interface EngineOptions {
  transport: Transport;
  /** Fabrique IndexedDB (celle du navigateur par défaut). */
  idb?: IDBFactory;
  dbName?: string;
  /** Horloge de l'appareil, injectable pour les tests. */
  now?: () => number;
  /** Au-delà, la vente est bloquée (PRD : 48 h hors ligne). */
  maxOfflineMs?: number;
  rangeSize?: number;
  /** On redemande une plage quand il en reste moins que cette part (PRD : 20 %). */
  lowWaterRatio?: number;
  /** Période des données de référence à emporter (par défaut : celle du serveur, soit −12 h à +7 jours). */
  referenceWindow?: () => { from?: string; to?: string };
}

export interface SellInput {
  tripId: string; fromStopId: string; toStopId: string; category?: FareCategory; seats?: number; clientId?: string;
  payment: { method: PaymentMethod; reference?: string };
}
export interface OfflineTicket { ticketId: string; number: number; qr: string; unitPrice: number; total: number; seats: number; soldAt: string }
export type LocalScanResult = 'valide' | 'deja_valide' | 'mauvais_depart' | 'signature_invalide' | 'inconnu' | 'illisible';
export interface LocalScan {
  result: LocalScanResult;
  /** Billet valide mais absent de la liste emportée : sera confirmé à la synchronisation. */
  sousReserve?: boolean;
  firstValidatedAt?: string;
  ticket?: { number: number; seats: number; tripId: string; departureAt: string };
}
export interface EngineStatus {
  deviceStatus: DeviceIdentity['status'];
  canSell: boolean;
  /** Raison du blocage de la vente, pour l'interface. */
  blockedReason?: 'poste_non_actif' | 'hors_ligne_trop_long' | 'plage_epuisee' | 'catalogue_absent';
  pendingSales: number;
  rejectedSales: number;
  pendingValidations: number;
  rangeRemaining: number;
  needsRange: boolean;
  lastServerContactAt?: number;
  offlineForMs?: number;
}
export interface SyncReport {
  ok: boolean;
  reason?: 'reseau' | 'poste_revoque' | 'poste_non_active' | 'poste_non_actif';
  sent: number;
  rejected: number;
  anomalies: string[];
}

export class OfflineEngine {
  private readonly store: OfflineStore;
  private readonly t: Transport;
  private readonly now: () => number;
  private readonly maxOfflineMs: number;
  private readonly rangeSize: number;
  private readonly lowWater: number;
  private readonly window: () => { from?: string; to?: string };
  private identity?: DeviceIdentity;

  constructor(opts: EngineOptions) {
    this.t = opts.transport;
    this.store = new OfflineStore(opts.idb ?? indexedDB, opts.dbName ?? 'transport-offline');
    this.now = opts.now ?? (() => Date.now());
    this.maxOfflineMs = opts.maxOfflineMs ?? 48 * HOUR;
    this.rangeSize = opts.rangeSize ?? 200;
    this.lowWater = opts.lowWaterRatio ?? 0.2;
    this.window = opts.referenceWindow ?? (() => ({}));
  }

  // ---------- identité du poste ----------

  /** Crée la paire de clés à la première utilisation ; la retrouve ensuite (survit aux redémarrages). */
  async init(name: string, kind: DeviceKind): Promise<DeviceIdentity> {
    this.identity = await this.store.get<DeviceIdentity>('kv', 'identity');
    if (!this.identity) {
      this.identity = { name, kind, ...(await generateKeyPair()), status: 'non_enregistre' };
      await this.store.put('kv', this.identity, 'identity');
    }
    return this.identity;
  }

  /** Renomme le poste tant qu'il n'est pas enregistré (le nom est vu par l'administrateur qui l'active). */
  async rename(name: string): Promise<void> {
    const id = this.must();
    if (!id.deviceId && name.trim()) await this.save({ name: name.trim().slice(0, 80) });
  }

  /** Envoie la clé publique au serveur ; un administrateur doit ensuite activer le poste. */
  async register(): Promise<DeviceIdentity> {
    const id = this.must();
    if (id.deviceId) return id;
    const r = await this.contact(() => this.t.requestDevice({ name: id.name, kind: id.kind, publicKey: id.publicKey }));
    return this.save({ deviceId: r.id, status: r.status });
  }

  /** Demande au serveur où en est l'activation (ou la révocation) du poste. */
  async refreshDevice(): Promise<DeviceIdentity> {
    const id = this.must();
    if (!id.deviceId) throw new OfflineError('poste_non_enregistre', 'Poste non enregistré');
    const s = await this.contact(() => this.t.deviceState(id.deviceId!));
    return this.save({ status: s.status, signingKeyId: s.signingKeyId, tenantId: s.tenantId });
  }

  // ---------- données de référence ----------

  async refreshReference(q: { from?: string; to?: string } = this.window()): Promise<void> {
    const id = this.must();
    if (id.kind === 'vente') {
      const c = await this.contact(() => this.t.catalog(q));
      await this.store.put('kv', { ...c, fetchedAt: this.now() }, 'catalog');
    } else {
      const d = await this.contact(() => this.t.controlData(q));
      await this.store.put('kv', { serverTime: d.serverTime, trips: d.trips, fetchedAt: this.now() }, 'control');
      await this.store.replaceAll('keys', d.keys);
      await this.store.replaceAll('tickets', d.tickets);
    }
  }

  // ---------- lecture pour l'interface ----------

  /** Identité du poste (copie) : état d'activation, nom, compagnie. Jamais la clé privée à l'écran. */
  getIdentity(): Omit<DeviceIdentity, 'privateKey'> | undefined {
    if (!this.identity) return undefined;
    const { privateKey, ...rest } = this.identity;
    void privateKey; // la clé privée ne sort jamais du moteur
    return rest;
  }

  /** Dernières données de référence d'un poste de vente (lignes, tarifs, départs), vues hors ligne comprises. */
  async getCatalog(): Promise<(CatalogResponse & { fetchedAt: number }) | undefined> {
    return this.store.get<CatalogResponse & { fetchedAt: number }>('kv', 'catalog');
  }

  /** Départs connus d'un poste de contrôle. */
  async getControlTrips(): Promise<{ serverTime: string; trips: RefTrip[]; fetchedAt: number } | undefined> {
    return this.store.get('kv', 'control');
  }

  // ---------- plages de numéros ----------

  async rangeRemaining(): Promise<number> {
    return (await this.store.getAll<RangeRecord>('ranges')).reduce((n, r) => n + Math.max(0, r.end - r.next + 1), 0);
  }

  /** Réserve une nouvelle plage quand il en reste peu. Sans réseau : ne fait rien (la vente continue sur la plage restante). */
  async ensureRange(): Promise<boolean> {
    const id = this.must();
    if (id.kind !== 'vente' || id.status !== 'actif' || !id.deviceId) return false;
    if ((await this.rangeRemaining()) > this.rangeSize * this.lowWater) return false;
    try {
      const r = await this.contact(() => this.t.reserveRange(id.deviceId!, this.rangeSize));
      await this.store.put('ranges', { start: r.start, end: r.end, next: r.start } satisfies RangeRecord);
      return true;
    } catch (e) {
      if (e instanceof NetworkError) return false;
      throw e;
    }
  }

  // ---------- vente hors ligne ----------

  async sellOffline(input: SellInput): Promise<OfflineTicket> {
    const id = this.must();
    const block = await this.saleBlock();
    if (block) throw new OfflineError(block, MESSAGES[block]);
    const catalog = (await this.store.get<CatalogResponse & { fetchedAt: number }>('kv', 'catalog'))!;
    const trip = catalog.trips.find((t) => t.id === input.tripId);
    if (!trip) throw new OfflineError('depart_inconnu', 'Départ absent des données du poste');
    if (trip.status === 'annule') throw new OfflineError('depart_annule', 'Ce départ est annulé');
    const line = catalog.lines.find((l) => l.id === trip.lineId);
    const from = line?.stops.find((s) => s.id === input.fromStopId);
    const to = line?.stops.find((s) => s.id === input.toStopId);
    if (!line || !from || !to || from.position >= to.position) throw new OfflineError('trajet_invalide', 'Trajet invalide pour cette ligne');
    const category = input.category ?? 'plein_tarif';
    const fare = line.fares.find((f) => f.fromStopId === from.id && f.toStopId === to.id && f.category === category);
    if (!fare) throw new OfflineError('tarif_absent', 'Aucun tarif pour ce trajet et cette catégorie');
    const seats = input.seats ?? 1;
    const pendingSeats = (await this.store.getAll<StoredSale>('sales')).filter((s) => s.tripId === trip.id && s.status === 'en_attente').reduce((n, s) => n + s.seats, 0);
    if (trip.seats - trip.sold - pendingSeats < seats) throw new OfflineError('plus_de_places', 'Plus assez de places (selon les données du poste)');

    const ticketId = newUuid();
    const soldAt = new Date(this.now()).toISOString();
    const total = fare.price * seats;
    // Numéro pris et vente enregistrée dans la même transaction : jamais de numéro perdu ni utilisé deux fois.
    const stored = await this.store.atomic(['ranges', 'sales'], async (tx) => {
      const ranges = await OfflineStore.request(tx.objectStore('ranges').getAll() as IDBRequest<RangeRecord[]>);
      const range = ranges.find((r) => r.next <= r.end);
      if (!range) throw new OfflineError('plage_epuisee', MESSAGES.plage_epuisee);
      const number = range.next;
      await OfflineStore.request(tx.objectStore('ranges').put({ ...range, next: number + 1 }));
      const payload = packTicketPayload({
        version: QR_VERSION, tenantId: id.tenantId!, keyId: id.signingKeyId!, ticketId, number, tripId: trip.id,
        departureAt: Math.floor(Date.parse(trip.departureAt) / 1000), price: total, seats,
      });
      return { number, payload };
    });
    const qr = encodeTicketQr(stored.payload, await signBytes(id.privateKey, stored.payload));
    const sale: StoredSale = {
      ticketId, number: stored.number, tripId: trip.id, fromStopId: from.id, toStopId: to.id, category, seats, total,
      ...(input.clientId ? { clientId: input.clientId } : {}), payment: input.payment, soldAt, qr, status: 'en_attente',
    };
    await this.store.put('sales', sale);
    return { ticketId, number: stored.number, qr, unitPrice: fare.price, total, seats, soldAt };
  }

  // ---------- contrôle hors ligne ----------

  async validateOffline(input: { qr: string; tripId?: string }): Promise<LocalScan> {
    const id = this.must();
    if (id.kind !== 'controle' || id.status !== 'actif') throw new OfflineError('poste_non_actif', MESSAGES.poste_non_actif);
    let decoded: ReturnType<typeof decodeTicketQr>;
    try {
      decoded = decodeTicketQr(input.qr);
    } catch {
      return { result: 'illisible' };
    }
    const p = decoded.payload;
    if (p.tenantId !== id.tenantId) return { result: 'inconnu' };
    const key = await this.store.get<PublicKeyInfo>('keys', p.keyId);
    if (!key || !(await verifyBytes(key.publicKey, decoded.payloadBytes, decoded.signature))) return { result: 'signature_invalide' };

    const cached = await this.store.get<CachedTicket>('tickets', p.ticketId);
    // Billet inconnu du poste signé par une clé révoquée : poste volé, refusé.
    if (!cached && key.status === 'revoque') return { result: 'signature_invalide' };
    if (cached && (cached.number !== p.number || cached.tripId !== p.tripId || cached.seats !== p.seats)) return { result: 'signature_invalide' };

    const summary = { number: p.number, seats: p.seats, tripId: p.tripId, departureAt: new Date(p.departureAt * 1000).toISOString() };
    const local = (await this.store.getAll<StoredValidation>('validations')).find((v) => v.ticketId === p.ticketId);
    if (local) return { result: 'deja_valide', firstValidatedAt: local.scannedAt, ticket: summary };
    if (cached?.status === 'valide') return { result: 'deja_valide', ...(cached.validatedAt ? { firstValidatedAt: cached.validatedAt } : {}), ticket: summary };
    if (input.tripId && p.tripId !== input.tripId) return { result: 'mauvais_depart', ticket: summary };

    const sousReserve = !cached;
    await this.store.put('validations', {
      clientId: newUuid(), ticketId: p.ticketId, qr: input.qr, scannedAt: new Date(this.now()).toISOString(),
      ...(input.tripId ? { tripId: input.tripId } : {}), localResult: sousReserve ? 'sous_reserve' : 'valide', status: 'en_attente',
    } satisfies StoredValidation);
    return { result: 'valide', ...(sousReserve ? { sousReserve: true } : {}), ticket: summary };
  }

  // ---------- état et synchronisation ----------

  async status(): Promise<EngineStatus> {
    const id = this.must();
    const sales = await this.store.getAll<StoredSale>('sales');
    const validations = await this.store.getAll<StoredValidation>('validations');
    const remaining = await this.rangeRemaining();
    const block = id.kind === 'vente' ? await this.saleBlock() : undefined;
    return {
      deviceStatus: id.status,
      canSell: id.kind === 'vente' && !block,
      ...(block ? { blockedReason: block } : {}),
      pendingSales: sales.filter((s) => s.status === 'en_attente').length,
      rejectedSales: sales.filter((s) => s.status === 'rejete').length,
      pendingValidations: validations.filter((v) => v.status === 'en_attente').length,
      rangeRemaining: remaining,
      needsRange: id.kind === 'vente' && remaining <= this.rangeSize * this.lowWater,
      ...(id.lastServerContactAt ? { lastServerContactAt: id.lastServerContactAt, offlineForMs: this.now() - id.lastServerContactAt } : {}),
    };
  }

  async listSales(): Promise<StoredSale[]> {
    return (await this.store.getAll<StoredSale>('sales')).sort((a, b) => a.number - b.number);
  }
  async listValidations(): Promise<StoredValidation[]> {
    return this.store.getAll<StoredValidation>('validations');
  }

  /** Envoie tout ce qui est en attente. Sans danger si elle est interrompue ou relancée : le serveur ignore les doublons. */
  async sync(): Promise<SyncReport> {
    const id = this.must();
    const report: SyncReport = { ok: true, sent: 0, rejected: 0, anomalies: [] };
    if (id.status !== 'actif' || !id.deviceId) return { ...report, ok: false, reason: 'poste_non_actif' };
    try {
      if (id.kind === 'vente') await this.pushSales(id.deviceId, report);
      else await this.pushValidations(id.deviceId, report);
      await this.ensureRange();
      await this.refreshReference().catch((e) => { if (!(e instanceof NetworkError)) throw e; });
      return report;
    } catch (e) {
      if (e instanceof NetworkError) return { ...report, ok: false, reason: 'reseau' };
      if (e instanceof ApiError && e.status === 403 && (e.body.code === 'poste_revoque' || e.body.code === 'poste_non_active')) {
        await this.save({ status: e.body.code === 'poste_revoque' ? 'revoque' : 'en_attente' });
        return { ...report, ok: false, reason: e.body.code as 'poste_revoque' | 'poste_non_active' };
      }
      throw e;
    }
  }

  private async pushSales(deviceId: string, report: SyncReport): Promise<void> {
    const pending = (await this.listSales()).filter((s) => s.status === 'en_attente');
    for (let i = 0; i < pending.length; i += 50) {
      const batch = pending.slice(i, i + 50);
      const res = await this.contact(() => this.t.syncSales({
        deviceId, deviceNow: new Date(this.now()).toISOString(),
        sales: batch.map((s) => ({
          ticketId: s.ticketId, number: s.number, tripId: s.tripId, fromStopId: s.fromStopId, toStopId: s.toStopId, category: s.category,
          seats: s.seats, total: s.total, ...(s.clientId ? { clientId: s.clientId } : {}), payment: s.payment, soldAt: s.soldAt, qr: s.qr,
        })),
      }));
      for (const r of res.results) {
        const sale = batch.find((s) => s.ticketId === r.ticketId);
        if (!sale) continue;
        if (r.result === 'rejete') {
          report.rejected++;
          await this.store.put('sales', { ...sale, status: 'rejete', reason: r.reason } satisfies StoredSale);
        } else {
          report.sent++;
          if (r.anomalies?.length) report.anomalies.push(...r.anomalies);
          await this.store.put('sales', { ...sale, status: 'synchronise', syncedAt: new Date(this.now()).toISOString(), ...(r.anomalies?.length ? { anomalies: r.anomalies } : {}) } satisfies StoredSale);
        }
      }
    }
  }

  private async pushValidations(deviceId: string, report: SyncReport): Promise<void> {
    const pending = (await this.listValidations()).filter((v) => v.status === 'en_attente').sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));
    for (let i = 0; i < pending.length; i += 100) {
      const batch = pending.slice(i, i + 100);
      const res = await this.contact(() => this.t.syncValidations({
        deviceId, deviceNow: new Date(this.now()).toISOString(),
        validations: batch.map((v) => ({ clientId: v.clientId, qr: v.qr, scannedAt: v.scannedAt, ...(v.tripId ? { tripId: v.tripId } : {}), localResult: v.localResult })),
      }));
      for (const r of res.results) {
        const v = batch.find((x) => x.clientId === r.clientId);
        if (!v) continue;
        report.sent++;
        if (r.result === 'doublon' || r.result === 'annule') report.anomalies.push(r.result);
        await this.store.put('validations', { ...v, status: 'synchronise', serverResult: r.result } satisfies StoredValidation);
      }
    }
  }

  // ---------- interne ----------

  private async saleBlock(): Promise<keyof typeof MESSAGES | undefined> {
    const id = this.must();
    if (id.kind !== 'vente' || id.status !== 'actif' || !id.signingKeyId || !id.tenantId) return 'poste_non_actif';
    if (!(await this.store.get('kv', 'catalog'))) return 'catalogue_absent';
    if (!id.lastServerContactAt || this.now() - id.lastServerContactAt > this.maxOfflineMs) return 'hors_ligne_trop_long';
    if ((await this.rangeRemaining()) === 0) return 'plage_epuisee';
    return undefined;
  }

  /** Tout échange réussi avec le serveur remet à zéro le compteur « hors ligne depuis ». */
  private async contact<T>(fn: () => Promise<T>): Promise<T> {
    const r = await fn();
    await this.save({ lastServerContactAt: this.now() });
    return r;
  }

  private must(): DeviceIdentity {
    if (!this.identity) throw new OfflineError('non_initialise', 'Appelez init() d\'abord');
    return this.identity;
  }

  private async save(patch: Partial<DeviceIdentity>): Promise<DeviceIdentity> {
    this.identity = { ...this.must(), ...patch };
    await this.store.put('kv', this.identity, 'identity');
    return this.identity;
  }
}

const MESSAGES = {
  poste_non_actif: 'Ce poste n\'est pas activé',
  hors_ligne_trop_long: 'Hors ligne depuis trop longtemps : connectez-vous pour reprendre les ventes',
  plage_epuisee: 'Plage de numéros épuisée : connectez-vous pour en obtenir une nouvelle',
  catalogue_absent: 'Données de référence absentes : connectez-vous une première fois',
} as const;
