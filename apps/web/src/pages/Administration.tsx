import { ChangeEvent, FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ROLES, Role } from '@transport/shared';
import { Alert, Badge, Button, DataTable, EmptyState, ErrorBox, Field, Loading, Modal, PageHead, Pager, Tabs } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { Company, setCompany, useCompany } from '../lib/company';
import { formatDateTime } from '../lib/format';
import { DEVICE_KIND_LABELS, DEVICE_STATUS_LABELS, roleLabel } from '../lib/labels';
import { getUser } from '../lib/session';
import { useAsync } from '../lib/useAsync';

type Tab = 'utilisateurs' | 'postes' | 'anomalies' | 'audit' | 'parametres';
const TABS: { id: Tab; label: string }[] = [
  { id: 'utilisateurs', label: 'Utilisateurs et rôles' }, { id: 'postes', label: 'Postes de vente' }, { id: 'anomalies', label: 'Anomalies' },
  { id: 'audit', label: "Journal d'audit" }, { id: 'parametres', label: 'Paramètres' },
];
const ASSIGNABLE = ROLES.filter((r) => r !== 'super_admin') as Role[];

export default function AdministrationPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('onglet');
  const tab: Tab = TABS.some((t) => t.id === raw) ? (raw as Tab) : 'utilisateurs';
  return (
    <>
      <PageHead title="Administration" subtitle="Utilisateurs, postes, anomalies, journal et paramètres de la compagnie" />
      <Tabs label="Administration" tabs={TABS} value={tab} onChange={(t) => setParams({ onglet: t }, { replace: true })} />
      <div className="card">
        {tab === 'utilisateurs' && <UsersTab />}
        {tab === 'postes' && <DevicesTab />}
        {tab === 'anomalies' && <AnomaliesTab />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'parametres' && <SettingsTab />}
      </div>
    </>
  );
}

// ---------- Utilisateurs ----------
interface User { id: string; email: string; fullName: string; active: boolean; roles: Role[] }
const randomPassword = (): string => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
};

function RolePicker({ value, onChange }: { value: Role[]; onChange: (r: Role[]) => void }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="lbl small" style={{ fontWeight: 600 }}>Rôles</legend>
      <div className="stack-sm">
        {ASSIGNABLE.map((r) => (
          <label key={r} className="row" style={{ minHeight: 'var(--tap)' }}>
            <input type="checkbox" checked={value.includes(r)} onChange={() => onChange(value.includes(r) ? value.filter((x) => x !== r) : [...value, r])} style={{ width: 22, height: 22 }} />
            {roleLabel(r)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function UserModal({ user, onClose, onDone }: { user?: User; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState(randomPassword());
  const [roles, setRoles] = useState<Role[]>(user?.roles ?? ['caissier']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      if (user) { await api.put(`/users/${user.id}/roles`, { roles }); onDone(); }
      else { await api.post('/users', { email: email.trim(), fullName: fullName.trim(), password, roles }); setCreated({ email: email.trim(), password }); }
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  if (created) {
    return (
      <Modal title="Compte créé" onClose={onDone}>
        <div className="stack">
          <Alert tone="ok">Communiquez ces identifiants à l'utilisateur. Le mot de passe ne sera plus affiché.</Alert>
          <p><strong>{created.email}</strong><br /><code className="num" data-testid="created-password">{created.password}</code></p>
          <Button variant="primary" onClick={onDone}>Terminé</Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={user ? `Rôles de ${user.fullName}` : 'Nouvel utilisateur'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <Alert>{error}</Alert>}
        {!user && <>
          <Field label="Nom complet">{(p) => <input {...p} className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />}</Field>
          <Field label="Adresse email">{(p) => <input {...p} className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Mot de passe provisoire" help="10 caractères au moins, généré pour vous.">{(p) => <input {...p} className="input" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        </>}
        <RolePicker value={roles} onChange={setRoles} />
        <div className="row"><Button type="submit" variant="primary" disabled={busy || roles.length === 0 || (!user && (fullName.trim().length < 2 || !email.includes('@') || password.length < 10))}>{busy ? 'Enregistrement…' : 'Enregistrer'}</Button><Button onClick={onClose}>Annuler</Button></div>
      </form>
    </Modal>
  );
}

function PasswordModal({ user, onClose }: { user: User; onClose: () => void }) {
  const [password, setPassword] = useState(randomPassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { await api.post(`/users/${user.id}/mot-de-passe`, { password }); setDone(true); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Nouveau mot de passe — ${user.fullName}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <Alert>{error}</Alert>}
        {done ? <Alert tone="ok">Mot de passe changé, compte déverrouillé et sessions fermées. Communiquez-le à l'utilisateur : <strong className="num">{password}</strong></Alert> : (
          <>
            <Field label="Nouveau mot de passe" help="10 caractères au moins. Ses sessions ouvertes seront fermées.">{(p) => <input {...p} className="input" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
            <div className="row"><Button type="submit" variant="primary" disabled={busy || password.length < 10}>Changer le mot de passe</Button><Button onClick={onClose}>Annuler</Button></div>
          </>
        )}
        {done && <Button variant="primary" onClick={onClose}>Fermer</Button>}
      </form>
    </Modal>
  );
}

function UsersTab() {
  const me = getUser();
  const { data, error, loading, reload } = useAsync((signal) => api.get<User[]>('/users', { signal }), []);
  const [modal, setModal] = useState<{ kind: 'new' } | { kind: 'roles' | 'password'; user: User } | null>(null);
  const [actionError, setActionError] = useState<string>();
  const toggle = async (u: User) => { setActionError(undefined); try { await api.patch(`/users/${u.id}`, { active: !u.active }); reload(); } catch (e) { setActionError(errorMessage(e)); } };
  return (
    <div className="stack">
      <div className="row between"><span className="muted small">Les comptes sont créés ici : il n'y a pas d'inscription libre.</span><Button variant="primary" icon="plus" onClick={() => setModal({ kind: 'new' })}>Nouvel utilisateur</Button></div>
      {actionError && <Alert>{actionError}</Alert>}
      {error ? <ErrorBox message={error} onRetry={reload} /> : loading && !data ? <Loading />
        : !data?.length ? <EmptyState title="Aucun utilisateur" />
        : <DataTable caption="Utilisateurs" rows={data} rowKey={(u) => u.id} columns={[
            { key: 'n', header: 'Nom', render: (u) => <span><strong>{u.fullName}</strong><br /><span className="muted small">{u.email}</span></span> },
            { key: 'r', header: 'Rôles', render: (u) => <span className="row" style={{ gap: 4 }}>{u.roles.map((r) => <Badge key={r} tone="info">{roleLabel(r)}</Badge>)}</span> },
            { key: 's', header: 'Statut', render: (u) => <Badge tone={u.active ? 'ok' : 'neutral'}>{u.active ? 'Actif' : 'Désactivé'}</Badge> },
            { key: 'a', header: '', className: 'actions', render: (u) => (
              <span className="row">
                <Button sm onClick={() => setModal({ kind: 'roles', user: u })}>Rôles</Button>
                <Button sm onClick={() => setModal({ kind: 'password', user: u })}>Mot de passe</Button>
                {u.id !== me?.id && <Button sm variant="ghost" onClick={() => void toggle(u)}>{u.active ? 'Désactiver' : 'Réactiver'}</Button>}
              </span>) },
          ]} />}
      {modal?.kind === 'new' && <UserModal onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal?.kind === 'roles' && <UserModal user={modal.user} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal?.kind === 'password' && <PasswordModal user={modal.user} onClose={() => setModal(null)} />}
    </div>
  );
}

// ---------- Postes ----------
interface Device { id: string; name: string; kind: string; status: string; lastSeenAt: string | null; ticketsSynced: number; rangesReserved: number; createdAt: string; revokeReason: string | null }
const deviceTone = (s: string) => (s === 'actif' ? 'ok' : s === 'revoque' ? 'danger' : 'warn') as 'ok' | 'danger' | 'warn';

function DevicesTab() {
  const { data, error, loading, reload } = useAsync((signal) => api.get<Device[]>('/postes', { signal }), []);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<string>();
  const activate = async (d: Device) => { setActionError(undefined); try { await api.post(`/postes/${d.id}/activation`, {}); reload(); } catch (e) { setActionError(errorMessage(e)); } };
  const revoke = async (e: FormEvent) => {
    e.preventDefault();
    try { await api.post(`/postes/${revoking!.id}/revocation`, { reason: reason.trim() }); setRevoking(null); setReason(''); reload(); } catch (err) { setActionError(errorMessage(err)); setRevoking(null); }
  };
  return (
    <div className="stack">
      <p className="muted small">Un poste se déclare depuis l'appareil (Billetterie ou Contrôle → « Demander l'activation »). Activez-le ici ; révoquez un poste perdu ou volé.</p>
      {actionError && <Alert>{actionError}</Alert>}
      {error ? <ErrorBox message={error} onRetry={reload} /> : loading && !data ? <Loading />
        : !data?.length ? <EmptyState title="Aucun poste déclaré">Les postes apparaissent ici quand un caissier ou un contrôleur demande l'activation de son appareil.</EmptyState>
        : <DataTable caption="Postes" rows={data} rowKey={(d) => d.id} columns={[
            { key: 'n', header: 'Poste', render: (d) => <strong>{d.name}</strong> },
            { key: 'k', header: 'Type', render: (d) => DEVICE_KIND_LABELS[d.kind] ?? d.kind },
            { key: 's', header: 'Statut', render: (d) => <Badge tone={deviceTone(d.status)}>{DEVICE_STATUS_LABELS[d.status]}</Badge> },
            { key: 'l', header: 'Dernier contact', render: (d) => (d.lastSeenAt ? formatDateTime(d.lastSeenAt) : '—') },
            { key: 't', header: 'Tickets', align: 'r', render: (d) => d.ticketsSynced },
            { key: 'a', header: '', className: 'actions', render: (d) => (
              <span className="row">
                {d.status === 'en_attente' && <Button sm variant="primary" onClick={() => void activate(d)}>Activer</Button>}
                {d.status !== 'revoque' && <Button sm variant="ghost" onClick={() => setRevoking(d)}>Révoquer</Button>}
                {d.status === 'revoque' && d.revokeReason && <span className="muted small">{d.revokeReason}</span>}
              </span>) },
          ]} />}
      {revoking && (
        <Modal title={`Révoquer « ${revoking.name} »`} onClose={() => setRevoking(null)}>
          <form className="stack" onSubmit={revoke}>
            <Alert tone="warn">Les ventes de ce poste pas encore synchronisées seront rejetées. Si le poste est simplement remplacé, faites-le d'abord synchroniser.</Alert>
            <Field label="Motif (obligatoire)">{(p) => <textarea {...p} className="input" value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
            <div className="row"><Button type="submit" variant="danger" disabled={reason.trim().length < 5}>Révoquer ce poste</Button><Button onClick={() => setRevoking(null)}>Annuler</Button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// ---------- Anomalies ----------
interface Anomaly { id: number; kind: string; status: string; ticketId: string | null; detail: Record<string, unknown>; createdAt: string; handledAt: string | null; note: string | null }
interface AnomalyPage { items: Anomaly[]; total: number; limit: number; offset: number }
export const ANOMALY_LABELS: Record<string, string> = {
  surreservation: 'Sur-réservation', depart_annule: 'Vente sur un départ annulé', ecart_tarif: 'Écart de tarif', reference_dupliquee: 'Référence de paiement en double',
  vente_rejetee: 'Vente rejetée à la synchronisation', validation_doublon: 'Double validation', validation_billet_annule: 'Billet annulé présenté', horloge_decalee: 'Horloge du poste décalée',
};

function AnomaliesTab() {
  const [status, setStatus] = useState<'ouverte' | 'traitee'>('ouverte');
  const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useAsync((signal) => api.get<AnomalyPage>(`/anomalies?status=${status}&limit=10&offset=${offset}`, { signal }), [status, offset]);
  const [actionError, setActionError] = useState<string>();
  const handle = async (a: Anomaly) => {
    const note = window.prompt('Note de traitement (facultatif)', '') ?? undefined;
    setActionError(undefined);
    try { await api.patch(`/anomalies/${a.id}`, note?.trim() ? { note: note.trim() } : {}); reload(); } catch (e) { setActionError(errorMessage(e)); }
  };
  return (
    <div className="stack">
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <Field label="Afficher">{(p) => <select {...p} className="input" value={status} onChange={(e) => { setStatus(e.target.value as 'ouverte' | 'traitee'); setOffset(0); }}><option value="ouverte">À traiter</option><option value="traitee">Traitées</option></select>}</Field>
      </div>
      {actionError && <Alert>{actionError}</Alert>}
      {error ? <ErrorBox message={error} onRetry={reload} /> : loading && !data ? <Loading />
        : !data?.items.length ? <EmptyState title={status === 'ouverte' ? 'Aucune anomalie à traiter' : 'Aucune anomalie traitée'} />
        : <>
          <DataTable caption="Rapport d'anomalies" rows={data.items} rowKey={(a) => String(a.id)} columns={[
            { key: 'k', header: 'Anomalie', render: (a) => <strong>{ANOMALY_LABELS[a.kind] ?? a.kind}</strong> },
            { key: 'd', header: 'Détail', render: (a) => <span className="small muted">{Object.entries(a.detail ?? {}).slice(0, 3).map(([k, v]) => `${k} : ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') || '—'}</span> },
            { key: 'w', header: 'Date', render: (a) => formatDateTime(a.createdAt) },
            { key: 'a', header: '', className: 'actions', render: (a) => (a.status === 'ouverte' ? <Button sm onClick={() => void handle(a)}>Marquer traitée</Button> : <span className="muted small">{a.note ?? 'Traitée'}</span>) },
          ]} />
          <Pager total={data.total} limit={data.limit} offset={data.offset} onChange={setOffset} />
        </>}
    </div>
  );
}

// ---------- Journal d'audit ----------
interface AuditItem { id: number; userId: string | null; action: string; objectType: string | null; objectId: string | null; before: unknown; after: unknown; createdAt: string }
interface AuditPage { items: AuditItem[]; total: number; limit: number; offset: number }
export const AUDIT_LABELS: Record<string, string> = {
  'anomaly.handled': 'Anomalie traitée', 'auth.login': 'Connexion', 'auth.login_failed': 'Échec de connexion', 'auth.login_locked': 'Compte verrouillé', 'auth.logout': 'Déconnexion',
  'auth.refresh_reuse_detected': 'Réutilisation de session détectée', 'device.activated': 'Poste activé', 'device.revoked': 'Poste révoqué', 'fare.changed': 'Tarif modifié',
  'line.created': 'Ligne créée', 'line.updated': 'Ligne modifiée', 'payment.verified': 'Paiement vérifié', 'stop.added': 'Arrêt ajouté', 'stop.removed': 'Arrêt retiré', 'stop.renamed': 'Arrêt renommé',
  'tenant.created': 'Compagnie créée', 'tenant.updated': 'Paramètres modifiés', 'tenant.activated': 'Compagnie activée', 'tenant.deactivated': 'Compagnie désactivée',
  'ticket.cancelled': 'Ticket annulé', 'trip.created': 'Départ créé', 'user.created': 'Utilisateur créé', 'user.password_reset': 'Mot de passe réinitialisé', 'user.roles_changed': 'Rôles modifiés',
  'user.activated': 'Utilisateur réactivé', 'user.deactivated': 'Utilisateur désactivé',
};
const AUDIT_FILTERS = [['', 'Toutes les actions'], ['ticket.', 'Tickets'], ['fare.', 'Tarifs'], ['user.', 'Utilisateurs et droits'], ['device.', 'Postes'], ['auth.', 'Connexions']] as const;

function summarize(i: AuditItem): string {
  const part = (v: unknown) => (v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k} : ${typeof x === 'object' ? JSON.stringify(x) : String(x)}`).join(', ') : '');
  const after = part(i.after);
  const before = part(i.before);
  return [before && `avant (${before})`, after && `après (${after})`].filter(Boolean).join(' → ') || '—';
}

function AuditTab() {
  const [prefix, setPrefix] = useState('');
  const [offset, setOffset] = useState(0);
  const users = useAsync((signal) => api.get<User[]>('/users', { signal }), []);
  const { data, error, loading, reload } = useAsync((signal) => api.get<AuditPage>(`/audit?limit=15&offset=${offset}${prefix ? `&action=${encodeURIComponent(prefix)}` : ''}`, { signal }), [prefix, offset]);
  const who = (id: string | null) => (id ? users.data?.find((u) => u.id === id)?.fullName ?? 'Utilisateur' : 'Système');
  return (
    <div className="stack">
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <Field label="Filtrer">{(p) => <select {...p} className="input" value={prefix} onChange={(e) => { setPrefix(e.target.value); setOffset(0); }}>{AUDIT_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}</Field>
      </div>
      <p className="muted small">Le journal est en lecture seule : aucune ligne ne peut être modifiée ni supprimée.</p>
      {error ? <ErrorBox message={error} onRetry={reload} /> : loading && !data ? <Loading />
        : !data?.items.length ? <EmptyState title="Aucune entrée" />
        : <>
          <DataTable caption="Journal d'audit" rows={data.items} rowKey={(i) => String(i.id)} columns={[
            { key: 'w', header: 'Date', render: (i) => <span className="small">{formatDateTime(i.createdAt)}</span> },
            { key: 'a', header: 'Action', render: (i) => <strong>{AUDIT_LABELS[i.action] ?? i.action}</strong> },
            { key: 'u', header: 'Par', render: (i) => who(i.userId) },
            { key: 'd', header: 'Détail', render: (i) => <span className="small muted">{summarize(i)}</span> },
          ]} />
          <Pager total={data.total} limit={data.limit} offset={data.offset} onChange={setOffset} />
        </>}
    </div>
  );
}

// ---------- Paramètres de la compagnie ----------
/** Réduit une image à 128 px et l'encode en PNG léger (≤ 60 000 caractères) pour la stocker avec la compagnie. */
async function logoFromFile(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 128 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale)); canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/png');
  if (url.length > 60_000) throw new Error('Image trop lourde : choisissez un logo plus simple.');
  return url;
}

function SettingsTab() {
  const company = useCompany();
  const [name, setName] = useState(company?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string }>();
  if (!company) return <Loading />;
  const save = async (body: { name?: string; logo?: string | null }) => {
    setBusy(true); setMsg(undefined);
    try { setCompany(await api.patch<Company>('/compagnie', body)); setMsg({ tone: 'ok', text: 'Paramètres enregistrés.' }); } catch (e) { setMsg({ tone: 'error', text: errorMessage(e) }); } finally { setBusy(false); }
  };
  const onLogo = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { await save({ logo: await logoFromFile(f) }); } catch (err) { setMsg({ tone: 'error', text: errorMessage(err) }); }
  };
  return (
    <div className="stack" style={{ maxWidth: 520 }}>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save({ name: name.trim() }); }}>
        <Field label="Nom de la compagnie">{(p) => <input {...p} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Button type="submit" variant="primary" disabled={busy || name.trim().length < 2 || name.trim() === company.name}>Enregistrer le nom</Button>
      </form>
      <div className="field">
        <span className="lbl">Logo</span>
        <div className="row">
          {company.logo ? <img src={company.logo} alt="Logo actuel" width={64} height={64} style={{ borderRadius: 'var(--r-md)', objectFit: 'cover' }} /> : <span className="muted small">Aucun logo</span>}
          <label className="btn" style={{ cursor: 'pointer' }}>Choisir une image<input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={onLogo} /></label>
          {company.logo && <Button variant="ghost" onClick={() => void save({ logo: null })}>Retirer</Button>}
        </div>
        <span className="help">Image réduite automatiquement (128 px) pour rester légère.</span>
      </div>
      <div className="field"><span className="lbl">Devise</span><p><strong>Franc CFA (FCFA)</strong> <span className="muted small">— montants entiers, sans décimales. Non modifiable dans cette version.</span></p></div>
    </div>
  );
}
