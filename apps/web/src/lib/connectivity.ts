import { useSyncExternalStore } from 'react';

/**
 * État du réseau tel que l'utilisateur le vit. `navigator.onLine` ment souvent (Wi-Fi sans Internet) :
 * on le complète par les succès/échecs réels des appels API et par un petit test périodique.
 */
export interface NetState { online: boolean }
let state: NetState = { online: typeof navigator === 'undefined' ? true : navigator.onLine !== false };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setOnline(online: boolean): void {
  if (state.online === online) return;
  state = { online };
  emit();
}
export const isOnline = (): boolean => state.online;
export const subscribeNet = (l: () => void): (() => void) => { listeners.add(l); return () => listeners.delete(l); };
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeNet, () => state.online, () => true);
}

/** Appel API réussi = le réseau marche ; échec réseau = il ne marche pas. */
export const reportNetworkResult = (ok: boolean): void => setOnline(ok);

let timer: ReturnType<typeof setInterval> | undefined;
export interface MonitorOptions { pingUrl?: string; everyMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch }

export async function ping(opts: MonitorOptions = {}): Promise<boolean> {
  const f = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await f(opts.pingUrl ?? '/api/v1/health', { cache: 'no-store', signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export function startNetworkMonitor(opts: MonitorOptions = {}): () => void {
  const check = async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return setOnline(false);
    setOnline(await ping(opts));
  };
  const onOnline = () => void check();
  const onOffline = () => setOnline(false);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  timer = setInterval(() => void check(), opts.everyMs ?? 15000);
  void check();
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    if (timer) clearInterval(timer);
  };
}
