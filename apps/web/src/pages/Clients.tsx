import { FormEvent, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, DataTable, EmptyState, ErrorBox, Field, Loading, Modal, PageHead, Pager } from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import { can } from '../lib/nav';
import { useUser } from '../lib/session';
import { useAsync, useDebounced } from '../lib/useAsync';
import { TicketList } from './billetterie/History';

interface Client { id: string; fullName: string; phone: string; email: string | null; createdAt: string }
interface Page { items: Client[]; total: number; limit: number; offset: number }

export function ClientsList() {
  const user = useUser();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const dq = useDebounced(q.trim());
  const qs = new URLSearchParams({ limit: '15', offset: String(offset), ...(dq ? { q: dq } : {}) });
  const { data, error, loading, reload } = useAsync((signal) => api.get<Page>(`/clients?${qs}`, { signal }), [qs.toString()]);
  const canWrite = can(user, 'clients:ecrire');
  return (
    <>
      <PageHead title="Clients" subtitle="Recherche par nom ou téléphone">
        {canWrite && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Nouveau client</Button>}
      </PageHead>
      <div className="card">
        <div className="toolbar">
          <Field label="Rechercher">{(p) => <input {...p} className="input" type="search" placeholder="Nom ou téléphone" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); setParams(e.target.value ? { q: e.target.value } : {}, { replace: true }); }} />}</Field>
        </div>
        {error ? <ErrorBox message={error} onRetry={reload} /> : loading && !data ? <Loading />
          : !data || data.items.length === 0 ? <EmptyState title="Aucun client">{dq ? 'Aucun résultat pour cette recherche.' : "Aucun client n'est enregistré."}</EmptyState>
          : <>
            <DataTable caption="Clients" rows={data.items} rowKey={(c) => c.id} onRowClick={(c) => nav(`/clients/${c.id}`)} columns={[
              { key: 'n', header: 'Nom', render: (c) => <Link to={`/clients/${c.id}`} onClick={(e) => e.stopPropagation()}><strong>{c.fullName}</strong></Link> },
              { key: 'p', header: 'Téléphone', render: (c) => <span className="num">{c.phone}</span> },
              { key: 'e', header: 'Email', render: (c) => c.email ?? '—' },
              { key: 'd', header: 'Depuis le', render: (c) => formatDate(c.createdAt) },
            ]} />
            <Pager total={data.total} limit={data.limit} offset={data.offset} onChange={setOffset} />
          </>}
      </div>
      {creating && <ClientForm onClose={() => setCreating(false)} onDone={(c) => nav(`/clients/${c.id}`)} />}
    </>
  );
}

function ClientForm({ client, onClose, onDone }: { client?: Client; onClose: () => void; onDone: (c: Client) => void }) {
  const [fullName, setFullName] = useState(client?.fullName ?? '');
  const [phone, setPhone] = useState(client?.phone ?? '');
  const [email, setEmail] = useState(client?.email ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      const body = { fullName: fullName.trim(), phone, email: email.trim() || null };
      onDone(client ? await api.patch<Client>(`/clients/${client.id}`, body) : await api.post<Client>('/clients', body));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? 'Un client avec ce numéro existe déjà.' : errorMessage(err)); setBusy(false);
    }
  };
  return (
    <Modal title={client ? 'Modifier le client' : 'Nouveau client'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <Alert>{error}</Alert>}
        <Field label="Nom complet">{(p) => <input {...p} className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />}</Field>
        <Field label="Téléphone" help="ex. +226 70 12 34 56">{(p) => <input {...p} className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
        <Field label="Email (facultatif)">{(p) => <input {...p} className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <div className="row"><Button type="submit" variant="primary" disabled={busy || fullName.trim().length < 2 || phone.replace(/\D/g, '').length < 8}>{busy ? 'Enregistrement…' : 'Enregistrer'}</Button><Button onClick={onClose}>Annuler</Button></div>
      </form>
    </Modal>
  );
}

export function ClientDetail() {
  const { id = '' } = useParams();
  const user = useUser();
  const [editing, setEditing] = useState(false);
  const { data: client, error, loading, reload, setData } = useAsync((signal) => api.get<Client>(`/clients/${id}`, { signal }), [id]);
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (loading && !client) return <Loading />;
  if (!client) return null;
  return (
    <>
      <PageHead title={client.fullName} subtitle={`Client depuis le ${formatDate(client.createdAt)}`}>
        {can(user, 'clients:ecrire') && <Button onClick={() => setEditing(true)}>Modifier</Button>}
        <Link className="btn" to="/clients">Tous les clients</Link>
      </PageHead>
      <div className="stack">
        <div className="card"><div className="grid-2"><div><span className="muted small">Téléphone</span><p className="num"><strong>{client.phone}</strong></p></div><div><span className="muted small">Email</span><p><strong>{client.email ?? '—'}</strong></p></div></div></div>
        <div className="card">
          <h2>Historique des achats</h2>
          {can(user, 'billetterie:lire') ? <TicketList canCancel={false} clientId={client.id} limit={8} /> : <p className="muted">L'historique des achats est réservé aux rôles de billetterie.</p>}
        </div>
      </div>
      {editing && <ClientForm client={client} onClose={() => setEditing(false)} onDone={(c) => { setData(c); setEditing(false); }} />}
    </>
  );
}
