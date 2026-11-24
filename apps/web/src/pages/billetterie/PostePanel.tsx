import { useState } from 'react';
import type { DeviceKind } from '@transport/shared';
import { Alert, Badge, Button, Field } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useOnline } from '../../lib/connectivity';
import type { Poste, PosteState } from '../../lib/poste';
import { formatDateTime } from '../../lib/format';

/** État du poste de cet appareil : activation par le directeur, plage de numéros, dernier contact. */
export function PostePanel({ poste, state, kind }: { poste: Poste | null; state: PosteState; kind: DeviceKind }) {
  const online = useOnline();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = state.identity;
  if (!poste || !state.ready || !id) return null;
  const label = kind === 'vente' ? 'vente' : 'contrôle';

  const register = async () => {
    setBusy(true); setError(undefined);
    try { await poste.register(name.trim() || undefined); await poste.syncNow(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  if (id.status === 'non_enregistre') {
    return (
      <div className="card flat stack" style={{ marginBottom: 'var(--sp-4)' }}>
        <h2>Activer ce poste de {label}</h2>
        <p className="muted small">Pour {kind === 'vente' ? 'vendre sans réseau' : 'contrôler sans réseau'}, ce poste doit être déclaré puis activé par le directeur. Sans cela, {kind === 'vente' ? 'la vente fonctionne uniquement avec du réseau' : 'le contrôle fonctionne uniquement avec du réseau'}.</p>
        {error && <Alert>{error}</Alert>}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Nom du poste">{(p) => <input {...p} className="input" placeholder={`ex. Guichet ${kind === 'vente' ? 'Ouaga gare' : 'quai 2'}`} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Button variant="primary" disabled={!online || busy} onClick={register}>{busy ? 'Envoi…' : 'Demander l’activation'}</Button>
        </div>
        {!online && <span className="small muted">Connexion requise pour déclarer le poste.</span>}
      </div>
    );
  }
  if (id.status === 'en_attente') {
    return <Alert tone="info" action={<Button sm disabled={!online} onClick={() => void poste.syncNow()}>Vérifier</Button>}>Poste « {id.name} » en attente d'activation par le directeur (Administration → Postes).</Alert>;
  }
  if (id.status === 'revoque') {
    return <Alert tone="error">Ce poste a été révoqué : il ne peut plus {kind === 'vente' ? 'vendre hors ligne' : 'contrôler hors ligne'}. Contactez le directeur.</Alert>;
  }
  const s = state.status;
  return (
    <div className="row small muted" style={{ marginBottom: 'var(--sp-3)' }}>
      <Badge tone="ok">Poste « {id.name} » actif</Badge>
      {kind === 'vente' && s && <span>{s.rangeRemaining} numéros réservés</span>}
      {s?.lastServerContactAt && <span>Dernier contact serveur : {formatDateTime(new Date(s.lastServerContactAt))}</span>}
      {s && s.rejectedSales > 0 && <Badge tone="danger">{s.rejectedSales} vente(s) rejetée(s)</Badge>}
    </div>
  );
}
