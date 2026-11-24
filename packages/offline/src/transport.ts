import type { DeviceKind } from '@transport/shared';
import { ApiError, CatalogResponse, ControlDataResponse, NetworkError, Transport } from './types';

/** Communication avec l'API. Une coupure réseau donne `NetworkError` ; une réponse d'erreur du serveur donne `ApiError`. */
export class HttpTransport implements Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | Promise<string>,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.getToken()}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new NetworkError(e instanceof Error ? e.message : 'Réseau indisponible');
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  }
  private qs(q?: { from?: string; to?: string }): string {
    const p = new URLSearchParams();
    if (q?.from) p.set('from', q.from);
    if (q?.to) p.set('to', q.to);
    return p.size ? `?${p}` : '';
  }

  requestDevice(input: { name: string; kind: DeviceKind; publicKey: string }) { return this.call<{ id: string; status: 'en_attente' | 'actif' | 'revoque' }>('POST', '/postes/demandes', input); }
  deviceState(id: string) { return this.call<Awaited<ReturnType<Transport['deviceState']>>>('GET', `/postes/${id}/etat`); }
  reserveRange(id: string, size: number) { return this.call<{ start: number; end: number; size: number }>('POST', `/postes/${id}/plages`, { size }); }
  catalog(q?: { from?: string; to?: string }) { return this.call<CatalogResponse>('GET', `/billetterie/referentiel${this.qs(q)}`); }
  controlData(q?: { from?: string; to?: string }) { return this.call<ControlDataResponse>('GET', `/controle/referentiel${this.qs(q)}`); }
  syncSales(body: { deviceId: string; deviceNow: string; sales: unknown[] }) { return this.call<Awaited<ReturnType<Transport['syncSales']>>>('POST', '/billetterie/synchronisation', body); }
  syncValidations(body: { deviceId: string; deviceNow: string; validations: unknown[] }) { return this.call<Awaited<ReturnType<Transport['syncValidations']>>>('POST', '/controle/synchronisation', body); }
}
