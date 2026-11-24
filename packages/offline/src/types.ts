import type { DeviceKind, DeviceStatus, FareCategory, PaymentMethod } from '@transport/shared';

export interface CatalogStop { id: string; name: string; position: number }
export interface CatalogFare { fromStopId: string; toStopId: string; category: FareCategory; price: number }
export interface CatalogLine { id: string; code: string; name: string; stops: CatalogStop[]; fares: CatalogFare[] }
export interface RefTrip { id: string; lineId: string; lineCode: string; departureAt: string; seats: number; status: string; sold: number }
export interface PublicKeyInfo { id: string; kind: 'serveur' | 'poste'; status: 'actif' | 'revoque'; publicKey: string }
export interface CachedTicket { id: string; number: number; tripId: string; seats: number; status: string; validatedAt: string | null }

export interface CatalogResponse { serverTime: string; lines: CatalogLine[]; trips: RefTrip[] }
export interface ControlDataResponse { serverTime: string; keys: PublicKeyInfo[]; trips: RefTrip[]; tickets: CachedTicket[] }

export interface DeviceIdentity {
  name: string;
  kind: DeviceKind;
  /** Clé privée Ed25519 (Base64 URL). Elle ne quitte jamais l'appareil. */
  privateKey: string;
  publicKey: string;
  deviceId?: string;
  tenantId?: string;
  status: 'non_enregistre' | DeviceStatus;
  signingKeyId?: string | null;
  /** Dernier échange réussi avec le serveur (heure de l'appareil, ms). Sert à la règle des 48 h hors ligne. */
  lastServerContactAt?: number;
}

export interface RangeRecord { id?: number; start: number; end: number; next: number }

export type SaleStatus = 'en_attente' | 'synchronise' | 'rejete';
export interface StoredSale {
  ticketId: string; number: number; tripId: string; fromStopId: string; toStopId: string; category: FareCategory;
  seats: number; total: number; clientId?: string; payment: { method: PaymentMethod; reference?: string };
  soldAt: string; qr: string;
  status: SaleStatus; reason?: string; anomalies?: string[]; syncedAt?: string;
}
export interface StoredValidation {
  clientId: string; ticketId: string; qr: string; scannedAt: string; tripId?: string;
  localResult: 'valide' | 'sous_reserve'; status: 'en_attente' | 'synchronise'; serverResult?: string;
}

export interface Transport {
  requestDevice(input: { name: string; kind: DeviceKind; publicKey: string }): Promise<{ id: string; status: DeviceStatus }>;
  deviceState(id: string): Promise<{ status: DeviceStatus; kind: DeviceKind; tenantId: string; signingKeyId: string | null; serverTime: string }>;
  reserveRange(id: string, size: number): Promise<{ start: number; end: number; size: number }>;
  catalog(q?: { from?: string; to?: string }): Promise<CatalogResponse>;
  controlData(q?: { from?: string; to?: string }): Promise<ControlDataResponse>;
  syncSales(body: { deviceId: string; deviceNow: string; sales: unknown[] }): Promise<{ serverTime: string; results: SaleSyncResult[] }>;
  syncValidations(body: { deviceId: string; deviceNow: string; validations: unknown[] }): Promise<{ serverTime: string; results: ValidationSyncResult[] }>;
}
export interface SaleSyncResult { ticketId: string; result: 'ok' | 'deja_synchronise' | 'rejete'; number?: number; reason?: string; anomalies?: string[] }
export interface ValidationSyncResult { clientId: string; result: string; firstValidatedAt?: string }

export class NetworkError extends Error {}
export class ApiError extends Error {
  constructor(readonly status: number, readonly body: { message?: string; code?: string } & Record<string, unknown>) {
    super(body?.message ?? `Erreur ${status}`);
  }
}
/** Erreur métier côté appareil (plage épuisée, trop longtemps hors ligne…). `code` est destiné à l'interface. */
export class OfflineError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
