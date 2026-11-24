import { STORAGE_PREFIX } from '../config';

/** Stockage local tolérant (navigation privée, quota) : ne lève jamais d'exception. */
export const store = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(`${STORAGE_PREFIX}.${key}`);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}.${key}`, JSON.stringify(value));
    } catch {
      /* quota ou mode privé : on continue sans persistance */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(`${STORAGE_PREFIX}.${key}`);
    } catch {
      /* rien */
    }
  },
};
