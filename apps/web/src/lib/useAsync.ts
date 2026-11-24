import { DependencyList, useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';

export interface Async<T> { data: T | undefined; error: string | undefined; loading: boolean; reload: () => void; setData: (d: T) => void }

/** Charge des données ; ignore les réponses périmées si les paramètres changent ou si l'écran est quitté. */
export function useAsync<T>(load: (signal: AbortSignal) => Promise<T>, deps: DependencyList): Async<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    loadRef.current(ctl.signal).then(
      (d) => { if (!ctl.signal.aborted) { setData(d); setError(undefined); setLoading(false); } },
      (e) => { if (!ctl.signal.aborted) { setError(errorMessage(e)); setLoading(false); } },
    );
    return () => ctl.abort();
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
