import { Link } from 'react-router-dom';
import { useOnline } from '../lib/connectivity';
import { can } from '../lib/nav';
import { usePoste } from '../lib/poste';
import { useUser } from '../lib/session';
import { Icon } from './Icon';

export interface NetSummary { online: boolean; syncing: boolean; pending: number; anomalies: number; rejected: number }

/** Regroupe l'état des postes (vente + contrôle) de l'utilisateur pour le bandeau. */
export function useNetSummary(): NetSummary & { syncNow: () => void } {
  const user = useUser();
  const online = useOnline();
  const vente = usePoste('vente', can(user, 'billetterie:vendre'));
  const ctrl = usePoste('controle', can(user, 'controle:valider'));
  const pending = (vente.state.status?.pendingSales ?? 0) + (vente.state.status?.pendingValidations ?? 0) + (ctrl.state.status?.pendingValidations ?? 0);
  return {
    online,
    syncing: vente.state.syncing || ctrl.state.syncing,
    pending,
    anomalies: vente.state.anomalies + ctrl.state.anomalies,
    rejected: (vente.state.status?.rejectedSales ?? 0),
    syncNow: () => { void vente.poste?.syncNow(); void ctrl.poste?.syncNow(); },
  };
}

/** Bandeau permanent : En ligne / Hors ligne / Synchronisation en cours / N éléments en attente / Rapport d'anomalies. */
export function StatusBanner() {
  const user = useUser();
  const n = useNetSummary();
  const label = !n.online ? 'Hors ligne' : n.syncing ? 'Synchronisation en cours' : 'En ligne';
  const cls = !n.online ? 'offline' : n.syncing ? 'syncing' : '';
  const anomalyCount = n.anomalies + n.rejected;
  return (
    <div className={`netbar ${cls}`} role="status" aria-live="polite" data-testid="netbar">
      <Icon name={!n.online ? 'wifi-off' : n.syncing ? 'refresh' : 'wifi'} size={18} className={n.syncing ? 'spin' : undefined} />
      <span>{label}</span>
      {n.pending > 0 && <span className="chip">{n.pending} élément{n.pending > 1 ? 's' : ''} en attente</span>}
      {n.online && !n.syncing && n.pending > 0 && <button type="button" className="link" onClick={n.syncNow}>Synchroniser</button>}
      <span className="spacer" />
      {anomalyCount > 0 && (can(user, 'administration:administrer')
        ? <Link to="/administration?onglet=anomalies">Rapport d'anomalies ({anomalyCount})</Link>
        : <span>Anomalie signalée à la direction ({anomalyCount})</span>)}
    </div>
  );
}
