import { ApiError, NetworkError } from '@transport/offline';
import { API_BASE } from '../config';
import { reportNetworkResult } from './connectivity';
import { accessToken, refreshAccess } from './session';

export { ApiError, NetworkError };
const TIMEOUT_MS = 15_000;

export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }

async function raw(method: string, path: string, token: string, body: unknown, opts: RequestOptions): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  opts.signal?.addEventListener('abort', () => ctl.abort());
  try {
    return await fetch(`${API_BASE}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    reportNetworkResult(false);
    throw new NetworkError(e instanceof Error ? e.message : 'Réseau indisponible');
  } finally {
    clearTimeout(timer);
  }
}

async function request(method: string, path: string, body: unknown, opts: RequestOptions): Promise<Response> {
  let res = await raw(method, path, await accessToken(), body, opts);
  if (res.status === 401) res = await raw(method, path, await refreshAccess(), body, opts);
  reportNetworkResult(true);
  return res;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* corps non JSON */ }
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export const api = {
  get: async <T>(path: string, opts: RequestOptions = {}): Promise<T> => parse<T>(await request('GET', path, undefined, opts)),
  post: async <T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> => parse<T>(await request('POST', path, body, opts)),
  put: async <T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> => parse<T>(await request('PUT', path, body, opts)),
  delete: async <T = void>(path: string, opts: RequestOptions = {}): Promise<T> => parse<T>(await request('DELETE', path, undefined, opts)),
  patch: async <T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> => parse<T>(await request('PATCH', path, body, opts)),
  /** Téléchargement (CSV…) : renvoie le contenu et le nom de fichier proposé par le serveur. */
  download: async (path: string): Promise<{ blob: Blob; filename: string }> => {
    const res = await request('GET', path, undefined, { timeoutMs: 60_000 });
    if (!res.ok) await parse(res);
    const cd = res.headers.get('content-disposition') ?? '';
    return { blob: await res.blob(), filename: /filename="?([^";]+)"?/.exec(cd)?.[1] ?? 'export.csv' };
  },
};

/** `fetch` pour le moteur hors ligne : mêmes règles de renouvellement de jeton que le reste de l'application. */
export const authedFetch: typeof fetch = async (input, init) => {
  const call = async (token?: string) => {
    const headers = new Headers(init?.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  let res: Response;
  try {
    res = await call();
  } catch (e) {
    reportNetworkResult(false);
    throw e;
  }
  if (res.status === 401) res = await call(await refreshAccess());
  reportNetworkResult(true);
  return res;
};

/** Message lisible en français pour toute erreur. */
export function errorMessage(e: unknown): string {
  if (e instanceof NetworkError) return 'Réseau indisponible. Vérifiez votre connexion et réessayez.';
  if (e instanceof ApiError) {
    const body = e.body as { message?: unknown; issues?: { path: string; message: string }[] };
    const issues = body.issues?.length ? ` (${body.issues.map((i) => (i.path ? `${i.path} : ${i.message}` : i.message)).join(' ; ')})` : '';
    if (e.status === 401) return typeof body.message === 'string' && body.message !== 'Unauthorized' ? body.message : 'Session expirée. Reconnectez-vous.';
    if (e.status === 403) return "Vous n'avez pas le droit d'effectuer cette action.";
    if (e.status === 423) return 'Compte temporairement verrouillé après trop d\'échecs. Réessayez dans quelques minutes.';
    if (e.status === 429) return 'Trop de tentatives. Patientez un instant avant de réessayer.';
    if (e.status >= 500) return 'Erreur du serveur. Réessayez dans un instant.';
    if (typeof body.message === 'string') return body.message + issues;
    if (Array.isArray(body.message)) return body.message.join(' ; ');
  }
  if (e instanceof Error && e.message) return e.message;
  return 'Une erreur est survenue.';
}
