import { vi } from 'vitest';
import type { Role } from '@transport/shared';
import { __resetSession, __setSession } from '../lib/session';
import { setOnline } from '../lib/connectivity';

export type Req = { method: string; url: string; body: unknown; auth: string | null };
export type Handler = (req: Req) => { status?: number; body?: unknown } | undefined;

/** Faux serveur : répond selon les gestionnaires, 404 sinon. Garde la trace des appels. */
export function mockFetch(...handlers: Handler[]) {
  const calls: Req[] = [];
  const net = { down: false };
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = new Headers(init?.headers).get('authorization');
    const req: Req = { method, url, body, auth };
    calls.push(req);
    if (net.down) throw new TypeError('Failed to fetch');
    for (const h of handlers) {
      const r = h(req);
      if (r) return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: 'introuvable' }), { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls, net };
}

export const loginAs = (roles: Role[], extra: { tenantId?: string } = {}) =>
  __setSession({ id: 'u1', email: 'a@b.bf', fullName: 'Awa Traoré', tenantId: extra.tenantId ?? 'tenant-1', roles });
export function resetWorld(): void { __resetSession(); setOnline(true); vi.unstubAllGlobals(); }
