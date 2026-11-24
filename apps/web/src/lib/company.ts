import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { store } from './storage';
import { getUser } from './session';

export interface Company { id: string; name: string; slug: string; currency: string; logo: string | null }
let company: Company | null = store.get<Company>('company');
const listeners = new Set<() => void>();
const sub = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
export function setCompany(c: Company | null): void {
  company = c;
  if (c) store.set('company', c); else store.remove('company');
  listeners.forEach((l) => l());
}
/** Compagnie de l'utilisateur (nom, logo), gardée en cache local pour s'afficher hors ligne. */
export function useCompany(): Company | null {
  const user = getUser();
  useEffect(() => {
    if (!user?.tenantId) return;
    api.get<Company>('/compagnie').then(setCompany, () => undefined);
  }, [user?.tenantId]);
  return useSyncExternalStore(sub, () => company, () => null);
}
