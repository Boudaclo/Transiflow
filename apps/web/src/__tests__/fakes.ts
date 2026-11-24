import type { DeviceKind } from '@transport/shared';
import { CatalogResponse, ControlDataResponse, OfflineEngine, Transport } from '@transport/offline';

export const uuid = () => crypto.randomUUID();
export const IDS = { tenant: uuid(), line: uuid(), a: uuid(), b: uuid(), c: uuid(), trip: uuid(), signingKey: uuid() };

export function makeCatalog(departInMin = 60, seats = 50): CatalogResponse {
  return {
    serverTime: new Date().toISOString(),
    lines: [{
      id: IDS.line, code: 'OUA-BOB', name: 'Ouagadougou – Bobo-Dioulasso',
      stops: [{ id: IDS.a, name: 'Ouagadougou', position: 1 }, { id: IDS.b, name: 'Koudougou', position: 2 }, { id: IDS.c, name: 'Bobo-Dioulasso', position: 3 }],
      fares: [{ fromStopId: IDS.a, toStopId: IDS.c, category: 'plein_tarif', price: 6500 }, { fromStopId: IDS.a, toStopId: IDS.b, category: 'plein_tarif', price: 2000 }, { fromStopId: IDS.b, toStopId: IDS.c, category: 'plein_tarif', price: 4500 }],
    }],
    trips: [{ id: IDS.trip, lineId: IDS.line, lineCode: 'OUA-BOB', departureAt: new Date(Date.now() + departInMin * 60000).toISOString(), seats, status: 'actif', sold: 0 }],
  };
}

export interface FakeServer { transport: Transport; sold: unknown[]; validations: unknown[]; ranges: number; publicKeys: { id: string; kind: 'serveur' | 'poste'; status: 'actif' | 'revoque'; publicKey: string }[] }
/** Serveur factice côté moteur : activation immédiate, plages de 200 numéros sans chevauchement. */
export function fakeServer(deviceStatus: 'actif' | 'en_attente' = 'actif', catalog = makeCatalog()): FakeServer {
  const s: FakeServer = {
    sold: [], validations: [], ranges: 0, publicKeys: [],
    transport: {
      requestDevice: async () => ({ id: uuid(), status: deviceStatus }),
      deviceState: async () => ({ status: deviceStatus, kind: 'vente', tenantId: IDS.tenant, signingKeyId: IDS.signingKey, serverTime: new Date().toISOString() }),
      reserveRange: async (_id, size) => { const start = 1 + s.ranges * size; s.ranges++; return { start, end: start + size - 1, size }; },
      catalog: async () => ({ ...catalog, serverTime: new Date().toISOString() }),
      controlData: async (): Promise<ControlDataResponse> => ({ serverTime: new Date().toISOString(), keys: s.publicKeys, trips: catalog.trips, tickets: [] }),
      syncSales: async (b) => { s.sold.push(...b.sales); return { serverTime: new Date().toISOString(), results: (b.sales as { ticketId: string }[]).map((x) => ({ ticketId: x.ticketId, result: 'ok' as const })) }; },
      syncValidations: async (b) => { s.validations.push(...b.validations); return { serverTime: new Date().toISOString(), results: (b.validations as { clientId: string }[]).map((x) => ({ clientId: x.clientId, result: 'valide' })) }; },
    },
  };
  return s;
}

let n = 0;
export async function preparedEngine(kind: DeviceKind, server: FakeServer, name = 'Poste test'): Promise<OfflineEngine> {
  const e = new OfflineEngine({ transport: server.transport, dbName: `test-${kind}-${Date.now()}-${n++}` });
  await e.init(name, kind);
  await e.register();
  await e.refreshDevice();
  await e.refreshReference();
  if (kind === 'vente') await e.ensureRange();
  return e;
}
