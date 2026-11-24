import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { DeviceKind } from '@transport/shared';
import {
  CatalogResponse, DeviceIdentity, EngineStatus, HttpTransport, NetworkError, OfflineEngine, RefTrip, SyncReport,
} from '@transport/offline';
import { API_BASE } from '../config';
import { authedFetch } from './api';
import { isOnline, subscribeNet } from './connectivity';
import { accessToken, getUser } from './session';

export type PublicIdentity = Omit<DeviceIdentity, 'privateKey'>;
export interface PosteState {
  ready: boolean;
  identity?: PublicIdentity;
  status?: EngineStatus;
  catalog?: CatalogResponse & { fetchedAt: number };
  controlTrips?: { serverTime: string; trips: RefTrip[]; fetchedAt: number };
  syncing: boolean;
  /** Messages d'anomalie remontés par la dernière synchronisation (doublons de validation, ventes rejetées…). */
  anomalies: number;
  lastError?: string;
}

const NAMES: Record<DeviceKind, string> = { vente: 'Poste de vente', controle: 'Poste de contrôle' };
const SYNC_EVERY_MS = 20_000;
const REFERENCE_EVERY_MS = 5 * 60_000;

/** Un poste = un moteur hors ligne (clés, plage de numéros, file d'attente) pour un type donné, propre à une compagnie sur cet appareil. */
export class Poste {
  state: PosteState = { ready: false, syncing: false, anomalies: 0 };
  private listeners = new Set<() => void>();
  private busy: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private lastReference = 0;
  private unsubNet?: () => void;
  private started = false;

  constructor(readonly kind: DeviceKind, readonly engine: OfflineEngine) {}

  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  getState = (): PosteState => this.state;
  private set(patch: Partial<PosteState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Les opérations sur le moteur passent l'une après l'autre (pas de synchronisation en même temps qu'une demande de plage). */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.busy.then(job, job);
    this.busy = run.catch(() => undefined);
    return run;
  }

  async refresh(): Promise<void> {
    const identity = this.engine.getIdentity();
    if (!identity) return;
    const patch: Partial<PosteState> = { identity, ready: true, status: await this.engine.status() };
    if (this.kind === 'vente') patch.catalog = await this.engine.getCatalog();
    else patch.controlTrips = await this.engine.getControlTrips();
    this.set(patch);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.engine.init(NAMES[this.kind], this.kind);
    await this.refresh();
    this.unsubNet = subscribeNet(() => { if (isOnline()) void this.tick(true); });
    this.timer = setInterval(() => void this.tick(false), SYNC_EVERY_MS);
    void this.tick(true);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.unsubNet?.();
    this.started = false;
  }

  /** Un tour de boucle : activation, envoi de la file, données de référence. Silencieux hors ligne. */
  async tick(force: boolean): Promise<void> {
    if (!isOnline() || !getUser()) return;
    await this.serial(async () => {
      try {
        let id = this.engine.getIdentity();
        if (!id) return;
        if (id.deviceId && id.status !== 'actif') {
          await this.engine.refreshDevice();
          id = this.engine.getIdentity()!;
        }
        if (id.status === 'actif') {
          const st = await this.engine.status();
          const stale = Date.now() - this.lastReference > REFERENCE_EVERY_MS;
          if (st.pendingSales + st.pendingValidations > 0 || st.needsRange || force) {
            this.set({ syncing: true });
            const report = await this.engine.sync();
            this.afterSync(report);
            if (report.ok) this.lastReference = Date.now();
          } else if (stale) {
            await this.engine.refreshReference();
            this.lastReference = Date.now();
          }
        } else if ((!this.state.catalog && !this.state.controlTrips) || Date.now() - this.lastReference > REFERENCE_EVERY_MS) {
          await this.engine.refreshReference().catch(() => undefined);
          this.lastReference = Date.now();
        }
        this.set({ lastError: undefined });
      } catch (e) {
        if (!(e instanceof NetworkError)) this.set({ lastError: e instanceof Error ? e.message : 'Erreur de synchronisation' });
      } finally {
        this.set({ syncing: false });
        await this.refresh();
      }
    });
  }

  private afterSync(r: SyncReport): void {
    const n = r.anomalies.length + r.rejected;
    if (n > 0) this.set({ anomalies: this.state.anomalies + n });
  }

  /** Synchronisation à la demande (bouton « Synchroniser » et après chaque vente ou validation). */
  syncNow = (): Promise<void> => this.tick(true);

  async register(name?: string): Promise<void> {
    await this.serial(async () => {
      if (name) await this.engine.rename(name);
      await this.engine.register();
    });
    await this.refresh();
  }

  /** Données de référence rafraîchies (en ligne uniquement). */
  async reloadReference(): Promise<void> {
    await this.serial(() => this.engine.refreshReference());
    this.lastReference = Date.now();
    await this.refresh();
  }

  dismissAnomalies(): void { this.set({ anomalies: 0 }); }
}

const registry = new Map<string, Poste>();
export const posteKey = (tenantId: string, kind: DeviceKind) => `${tenantId}:${kind}`;

/** Fabrique par défaut (surchargée dans les tests). */
export let createEngine = (tenantId: string, kind: DeviceKind): OfflineEngine =>
  new OfflineEngine({ transport: new HttpTransport(API_BASE, () => accessToken(), authedFetch), dbName: `transport-${tenantId}-${kind}` });
export function __setEngineFactory(f: typeof createEngine): void { createEngine = f; registry.clear(); }

export function getPoste(tenantId: string, kind: DeviceKind): Poste {
  const k = posteKey(tenantId, kind);
  let p = registry.get(k);
  if (!p) { p = new Poste(kind, createEngine(tenantId, kind)); registry.set(k, p); }
  return p;
}

const EMPTY: PosteState = { ready: false, syncing: false, anomalies: 0 };
const noSub = () => () => undefined;

/** État du poste de ce type pour l'utilisateur connecté, démarré à la demande. */
export function usePoste(kind: DeviceKind, enabled = true): { poste: Poste | null; state: PosteState } {
  const tenantId = getUser()?.tenantId ?? null;
  const poste = useMemo(() => (enabled && tenantId ? getPoste(tenantId, kind) : null), [enabled, tenantId, kind]);
  useEffect(() => { void poste?.start(); }, [poste]);
  const state = useSyncExternalStore(poste ? poste.subscribe : noSub, poste ? poste.getState : () => EMPTY, () => EMPTY);
  return { poste, state };
}
