import { FormEvent, useState } from 'react';
import { Alert, Badge, Button, DataTable, EmptyState, ErrorBox, Field, Loading, Modal, PageHead } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import { useAsync } from '../lib/useAsync';

interface Tenant { id: string; name: string; slug: string; active: boolean; createdAt: string }

/** Espace du super-administrateur plateforme : créer des compagnies (avec leur directeur) et les activer ou suspendre. */
export default function CompagniesPage() {
  const { data, error, loading, reload } = useAsync((signal) => api.get<Tenant[]>('/tenants', { signal }), []);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const toggle = async (t: Tenant) => {
    if (t.active && !window.confirm(`Suspendre « ${t.name} » ? Tous ses utilisateurs seront déconnectés.`)) return;
    setActionError(undefined);
    try { await api.patch(`/tenants/${t.id}`, { active: !t.active }); reload(); } catch (e) { setActionError(errorMessage(e)); }
  };
  return (
    <>
      <PageHead title="Compagnies" subtitle="Gestion des compagnies clientes de la plateforme"><Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Nouvelle compagnie</Button></PageHead>
      <div className="card">
        {actionError && <Alert>{actionError}</Alert>}
        {error ? <ErrorBox message={error} onRetry={reload} /> : loading && !data ? <Loading />
          : !data?.length ? <EmptyState title="Aucune compagnie" />
          : <DataTable caption="Compagnies" rows={data} rowKey={(t) => t.id} columns={[
              { key: 'n', header: 'Compagnie', render: (t) => <strong>{t.name}</strong> },
              { key: 's', header: 'Code', render: (t) => t.slug },
              { key: 'a', header: 'Statut', render: (t) => <Badge tone={t.active ? 'ok' : 'danger'}>{t.active ? 'Active' : 'Suspendue'}</Badge> },
              { key: 'd', header: 'Créée le', render: (t) => formatDate(t.createdAt) },
              { key: 'x', header: '', className: 'actions', render: (t) => <Button sm variant={t.active ? 'ghost' : 'primary'} onClick={() => void toggle(t)}>{t.active ? 'Suspendre' : 'Réactiver'}</Button> },
            ]} />}
      </div>
      {creating && <NewTenant onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
    </>
  );
}

function NewTenant({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', slug: '', adminName: '', adminEmail: '', adminPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { await api.post('/tenants', { ...f, slug: f.slug.trim().toLowerCase() }); onDone(); } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return (
    <Modal title="Nouvelle compagnie" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <Alert>{error}</Alert>}
        <Field label="Nom de la compagnie">{(p) => <input {...p} className="input" value={f.name} onChange={set('name')} />}</Field>
        <Field label="Code (minuscules, sans espace)" help="ex. sotraco">{(p) => <input {...p} className="input" value={f.slug} onChange={set('slug')} />}</Field>
        <Field label="Nom du directeur">{(p) => <input {...p} className="input" value={f.adminName} onChange={set('adminName')} />}</Field>
        <Field label="Email du directeur">{(p) => <input {...p} className="input" type="email" value={f.adminEmail} onChange={set('adminEmail')} />}</Field>
        <Field label="Mot de passe provisoire" help="10 caractères au moins">{(p) => <input {...p} className="input" value={f.adminPassword} onChange={set('adminPassword')} />}</Field>
        <div className="row"><Button type="submit" variant="primary" disabled={busy || Object.values(f).some((v) => !v.trim()) || f.adminPassword.length < 10}>{busy ? 'Création…' : 'Créer la compagnie'}</Button><Button onClick={onClose}>Annuler</Button></div>
      </form>
    </Modal>
  );
}
