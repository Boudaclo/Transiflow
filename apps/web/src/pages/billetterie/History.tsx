import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, DataTable, EmptyState, ErrorBox, Field, Loading, Modal, Pager } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, formatDeparture, formatFcfa } from '../../lib/format';
import { PAYMENT_LABELS, PAYMENT_STATUS_LABELS, TICKET_STATUS_LABELS } from '../../lib/labels';
import { useAsync } from '../../lib/useAsync';

export interface TicketRowView {
  id: string; number: number; status: 'vendu' | 'valide' | 'annule'; seats: number; total: number; soldAt: string; offline: boolean;
  trip: { lineCode: string; lineName: string; departureAt: string } | null; from: { name: string | null }; to: { name: string | null };
  payment: { method: string; reference: string | null; status: string }; cancelReason: string | null; validatedAt: string | null; clientId: string | null;
}
interface Page { items: TicketRowView[]; total: number; limit: number; offset: number }

export const ticketTone = (s: string) => (s === 'valide' ? 'ok' : s === 'annule' ? 'danger' : 'info') as 'ok' | 'danger' | 'info';

/** Liste des tickets (recherche par numéro, filtre par statut). Utilisée aussi dans la fiche client (clientId). */
export function TicketList({ canCancel, canVerify = false, clientId, limit = 10 }: { canCancel: boolean; canVerify?: boolean; clientId?: string; limit?: number }) {
  const [number, setNumber] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [cancelTarget, setCancelTarget] = useState<TicketRowView | null>(null);
  const [verifyError, setVerifyError] = useState<string>();
  const verify = async (t: TicketRowView) => { setVerifyError(undefined); try { await api.post(`/billetterie/tickets/${t.id}/paiement-verifie`, {}); reload(); } catch (e) { setVerifyError(errorMessage(e)); } };
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (/^\d+$/.test(number)) qs.set('number', number);
  if (status) qs.set('status', status);
  if (clientId) qs.set('clientId', clientId);
  const { data, error, loading, reload } = useAsync((signal) => api.get<Page>(`/billetterie/tickets?${qs}`, { signal }), [qs.toString()]);

  return (
    <div>
      <div className="toolbar">
        {!clientId && <Field label="N° de ticket">{(p) => <input {...p} className="input" inputMode="numeric" value={number} onChange={(e) => { setNumber(e.target.value); setOffset(0); }} />}</Field>}
        <Field label="Statut">
          {(p) => <select {...p} className="input" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
            <option value="">Tous</option>
            {Object.entries(TICKET_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>}
        </Field>
      </div>
      {verifyError && <Alert>{verifyError}</Alert>}
      {error ? <ErrorBox message={error} onRetry={reload} />
        : loading && !data ? <Loading />
        : !data || data.items.length === 0 ? <EmptyState title="Aucun ticket">Aucun ticket ne correspond à cette recherche.</EmptyState>
        : (
          <>
            <DataTable caption="Tickets" rows={data.items} rowKey={(r) => r.id} columns={[
              { key: 'n', header: 'N°', render: (r) => <strong className="num">{r.number}</strong> },
              { key: 'trip', header: 'Trajet', render: (r) => <span>{r.from.name} → {r.to.name}<br /><span className="muted small">{r.trip ? `${r.trip.lineCode} · ${formatDeparture(r.trip.departureAt)}` : ''}</span></span> },
              { key: 'seats', header: 'Places', align: 'r', render: (r) => r.seats },
              { key: 'total', header: 'Montant', align: 'r', render: (r) => <span className="num">{formatFcfa(r.total)}</span> },
              { key: 'pay', header: 'Paiement', render: (r) => <span>{PAYMENT_LABELS[r.payment.method] ?? r.payment.method}{r.payment.status === 'a_verifier' && <> <Badge tone="warn">{PAYMENT_STATUS_LABELS.a_verifier}</Badge></>}</span> },
              { key: 'st', header: 'Statut', render: (r) => <Badge tone={ticketTone(r.status)}>{TICKET_STATUS_LABELS[r.status]}</Badge> },
              { key: 'date', header: 'Vendu le', render: (r) => <span className="small">{formatDateTime(r.soldAt)}{r.offline ? ' (hors ligne)' : ''}</span> },
              { key: 'a', header: '', className: 'actions', render: (r) => (<span className="row">{canVerify && r.payment.status === 'a_verifier' && r.status !== 'annule' && <Button sm onClick={() => void verify(r)}>Confirmer le paiement</Button>}{canCancel && r.status !== 'annule' ? <Button sm variant="ghost" onClick={() => setCancelTarget(r)}>Annuler</Button> : null}</span>) },
              { key: 'm', header: '', className: 'actions', render: (r) => (r.cancelReason ? <span className="muted small" title={r.cancelReason}>Motif : {r.cancelReason}</span> : null) },
            ]} />
            <Pager total={data.total} limit={data.limit} offset={data.offset} onChange={setOffset} />
          </>
        )}
      {cancelTarget && <CancelModal ticket={cancelTarget} onClose={() => setCancelTarget(null)} onDone={() => { setCancelTarget(null); reload(); }} />}
    </div>
  );
}

function CancelModal({ ticket, onClose, onDone }: { ticket: TicketRowView; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { await api.post(`/billetterie/tickets/${ticket.id}/annulation`, { reason: reason.trim() }); onDone(); } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return (
    <Modal title={`Annuler le ticket n° ${ticket.number}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">{ticket.from.name} → {ticket.to.name} · {formatFcfa(ticket.total)}. L'annulation et le remboursement exigent une connexion et sont journalisés.</p>
        {error && <Alert>{error}</Alert>}
        <Field label="Justification (obligatoire)" help="5 caractères au moins">{(p) => <textarea {...p} className="input" value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <div className="row"><Button type="submit" variant="danger" disabled={reason.trim().length < 5 || busy}>{busy ? 'Annulation…' : "Confirmer l'annulation"}</Button><Button onClick={onClose}>Retour</Button></div>
      </form>
    </Modal>
  );
}

export const HistoryNote = () => <p className="muted small">Les ventes faites sans réseau apparaissent ici après leur synchronisation. <Link to="/billetterie">Retour à la vente</Link></p>;
