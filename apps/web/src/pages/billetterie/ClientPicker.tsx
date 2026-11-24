import { useState } from 'react';
import { Alert, Button, Field } from '../../components/ui';
import { ApiError, api, errorMessage } from '../../lib/api';
import { useDebounced } from '../../lib/useAsync';
import { useEffect } from 'react';

export interface ClientLite { id: string; fullName: string; phone: string }
interface Page { items: ClientLite[] }

/** Client optionnel : recherche par téléphone ou nom, ou création rapide. Nécessite le réseau (la vente, elle, n'en a pas besoin). */
export function ClientPicker({ online, canCreate, value, onChange }: { online: boolean; canCreate: boolean; value: ClientLite | null; onChange: (c: ClientLite | null) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ClientLite[]>([]);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const dq = useDebounced(q.trim(), 350);

  useEffect(() => {
    if (!online || dq.length < 3 || value) { setResults([]); return; }
    let live = true;
    api.get<Page>(`/clients?q=${encodeURIComponent(dq)}&limit=5`).then(
      (p) => { if (live) { setResults(p.items); setError(undefined); } },
      (e) => { if (live) setError(errorMessage(e)); },
    );
    return () => { live = false; };
  }, [dq, online, value]);

  if (value) {
    return (
      <div className="row between">
        <span><strong>{value.fullName}</strong> <span className="muted">{value.phone}</span></span>
        <Button sm variant="ghost" onClick={() => onChange(null)}>Retirer</Button>
      </div>
    );
  }
  if (!online) return <p className="muted small">Client indisponible hors ligne (facultatif).</p>;

  const create = async () => {
    setError(undefined);
    try {
      const c = await api.post<ClientLite>('/clients', { fullName: name.trim(), phone: q.trim() });
      onChange(c); setCreating(false); setName(''); setQ('');
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? 'Ce numéro existe déjà : recherchez-le.' : errorMessage(e));
    }
  };

  return (
    <div className="stack-sm">
      <Field label="Client (facultatif)" help="Téléphone ou nom">
        {(p) => <input {...p} className="input" type="search" inputMode="tel" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ex. 70 12 34 56" />}
      </Field>
      {error && <Alert tone="error">{error}</Alert>}
      {results.map((c) => (
        <button key={c.id} type="button" className="btn" style={{ justifyContent: 'space-between' }} onClick={() => onChange(c)}>
          <span>{c.fullName}</span><span className="muted">{c.phone}</span>
        </button>
      ))}
      {canCreate && dq.length >= 3 && results.length === 0 && !creating && (
        <Button sm onClick={() => setCreating(true)} icon="plus">Créer ce client</Button>
      )}
      {creating && (
        <div className="stack-sm">
          <Field label="Nom du client">{(p) => <input {...p} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <div className="row"><Button sm variant="primary" disabled={name.trim().length < 2} onClick={create}>Enregistrer</Button><Button sm variant="ghost" onClick={() => setCreating(false)}>Annuler</Button></div>
        </div>
      )}
    </div>
  );
}
