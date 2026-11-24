import { useSyncExternalStore } from 'react';
import type { Permission, Role } from '@transport/shared';
import { permissionsFor } from '@transport/shared';
import { ApiError, NetworkError } from '@transport/offline';
import { API_BASE } from '../config';
import { reportNetworkResult } from './connectivity';
import { store } from './storage';

export interface SessionUser { id: string; email: string; fullName: string; tenantId: string | null; roles: Role[]; permissions: Permission[] }
interface Stored { user: SessionUser; refreshToken: string }
interface LoginResponse { accessToken: string; refreshToken: string; expiresIn: number; user: SessionUser }

const KEY = 'session';
let current: Stored | null = store.get<Stored>(KEY);
let access: { token: string; exp: number } | null = null;
let refreshing: Promise<string> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const getUser = (): SessionUser | null => current?.user ?? null;
export const subscribeSession = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
export function useUser(): SessionUser | null {
  return useSyncExternalStore(subscribeSession, getUser, () => null);
}

function apply(res: LoginResponse): void {
  current = { user: res.user, refreshToken: res.refreshToken };
  access = { token: res.accessToken, exp: Date.now() + res.expiresIn * 1000 };
  store.set(KEY, current);
  emit();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    reportNetworkResult(false);
    throw new NetworkError(e instanceof Error ? e.message : 'Réseau indisponible');
  }
  reportNetworkResult(true);
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export async function login(email: string, password: string): Promise<SessionUser> {
  const res = await post<LoginResponse>('/auth/login', { email, password });
  apply({ ...res, user: { ...res.user, permissions: permissionsFor(res.user.roles) } });
  return getUser()!;
}

export function clearSession(): void {
  current = null;
  access = null;
  store.remove(KEY);
  emit();
}

export async function logout(): Promise<void> {
  const rt = current?.refreshToken;
  clearSession();
  if (rt) await post('/auth/logout', { refreshToken: rt }).catch(() => undefined);
}

/** Renouvelle le jeton (un seul appel à la fois, même si dix requêtes le demandent). Session perdue = déconnexion ; réseau coupé = on garde la session. */
export function refreshAccess(): Promise<string> {
  if (!current) return Promise.reject(new ApiError(401, { message: 'Non connecté' }));
  refreshing ??= (async () => {
    try {
      const res = await post<LoginResponse>('/auth/refresh', { refreshToken: current!.refreshToken });
      apply({ ...res, user: { ...res.user, permissions: permissionsFor(res.user.roles) } });
      return res.accessToken;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) clearSession();
      throw e;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Jeton valide pour un appel : réutilise celui en mémoire tant qu'il a plus de 30 s devant lui. */
export async function accessToken(): Promise<string> {
  if (access && access.exp - Date.now() > 30_000) return access.token;
  return refreshAccess();
}

/** Pour les tests. */
export function __resetSession(): void {
  current = null; access = null; refreshing = null;
}

/** Pour les tests : ouvre une session sans passer par le réseau. */
export function __setSession(user: Omit<SessionUser, 'permissions'> & { permissions?: Permission[] }, token = 'test-token'): void {
  current = { user: { ...user, permissions: user.permissions ?? permissionsFor(user.roles) }, refreshToken: 'rt' };
  access = { token, exp: Date.now() + 3600_000 };
  emit();
}
