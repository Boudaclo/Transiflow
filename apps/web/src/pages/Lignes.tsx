import { FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FareCategory, TRIP_STATUSES } from '@transport/shared';
import { Alert, Badge, Button, DataTable, EmptyState, ErrorBox, Field, Loading, Modal, PageHead, Pager, Tabs } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { addDays, formatDeparture, formatFcfa, startOfDay, toInputDate, toInputDateTime } from '../lib/format';
import { CATEGORY_LABELS, TRIP_STATUS_LABELS } from '../lib/labels';
import { can } from '../lib/nav';
import { useUser } from '../lib/session';
import { useAsync } from '../lib/useAsync';

/** Catégories ouvertes à la vente au lancement : une seule. Ajouter 'enfant' ou 'etudiant' ici suffira à les proposer. */
const ACTIVE_CATEGORIES: FareCategory[] = ['plein_tarif'];
interface LineSummary { id: string; code: string; name: string; active: boolean; stopsCount: number }
interface Stop { id: string; name: string; position: number }
interface Fare { id: string; fromStopId: string; toStopId: string; category: FareCategory; price: number; active: boolean }
interface Line { id: string; code: string; name: string; active: boolean; stops: Stop[]; fares: Fare[] }
interface Trip { id: string; lineId: string; lineCode: string; lineName: string; departureAt: string; seats: number; status: string }
interface TripPage { items: Trip[]; total: number; limit: number; offset: number }
const tripTone = (s: string) => (s === 'actif' ? 'ok' : s === 'retarde' ? 'warn' : 'danger') as 'ok' | 'warn' | 'danger';

export function LignesList() {
  const user = useUser();
  const nav = useNavigate();
  const canWrite = can(user, 'lignes:ecrire');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const { data, error, loading, reload } = useAsync((signal) => api.get<LineSummary[]>('/lignes', { signal }), []);
  const rows = useMemo(() => (data ?? []).filter((l) => `${l.code} ${l.name}`.toLowerCase().includes(q.trim().toLowerCase())), [data, q]);
  return (
    <>
      <PageHead title="Lignes et départs" subtitle="Lignes, arrêts, tarifs et planification des départs">
        {canWrite && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Nouvelle ligne</Button>}
      </PageHead>
      <div className="card">
        <div className="toolbar"><Field label="Rechercher">{(p) => <input {...p} className="input" type="search" placeholder="Code ou nom de ligne" value={q} onChange={(e) => setQ(e.target.value)} />}</Field></div>
        {error ? <ErrorBox message={error} onRetry={reload} /> : loading && !data ? <Loading />
          : rows.length === 0 ? <EmptyState title="Aucune ligne" action={canWrite ? <Button variant="primary" onClick={() => setCreating(true)}>Créer la première ligne</Button> : undefined}>{data?.length ? 'Aucun résultat pour cette recherche.' : "Aucune ligne n'est configurée."}</EmptyState>
          : <DataTable caption="Lignes" rows={rows} rowKey={(r) => r.id} onRowClick={(r) => nav(`/lignes/${r.id}`)} columns={[
              { key: 'code', header: 'Code', render: (r) => <strong>{r.code}</strong> },
              { key: 'name', header: 'Ligne', render: (r) => <Link to={`/lignes/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.name}</Link> },
              { key: 'stops', header: 'Arrêts', align: 'r', render: (r) => r.stopsCount },
              { key: 'st', header: 'Statut', render: (r) => <Badge tone={r.active ? 'ok' : 'neutral'}>{r.active ? 'Active' : 'Inactive'}</Badge> },
            ]} />}
      </div>
      {creating && <NewLine onClose={() => setCreating(false)} onDone={(id) => nav(`/lignes/${id}`)} />}
    </>
  );
}

function NewLine({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [stops, setStops] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const list = stops.split('\n').map((s) => s.trim()).filter(Boolean);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { const l = await api.post<Line>('/lignes', { code, name, stops: list }); onDone(l.id); } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return (
    <Modal title="Nouvelle ligne" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <Alert>{error}</Alert>}
        <Field label="Code" help="ex. OUA-BOB">{(p) => <input {...p} className="input" value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
        <Field label="Nom de la ligne">{(p) => <input {...p} className="input" placeholder="Ouagadougou – Bobo-Dioulasso" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Arrêts, dans l'ordre (un par ligne)" help={`${list.length} arrêt(s) : au moins 2`}>{(p) => <textarea {...p} className="input" style={{ minHeight: 140 }} value={stops} onChange={(e) => setStops(e.target.value)} />}</Field>
        <div className="row"><Button type="submit" variant="primary" disabled={busy || code.length < 2 || name.length < 2 || list.length < 2}>{busy ? 'Création…' : 'Créer la ligne'}</Button><Button onClick={onClose}>Annuler</Button></div>
      </form>
    </Modal>
  );
}

export function LigneDetail() {
  const { id = '' } = useParams();
  const user = useUser();
  const canWrite = can(user, 'lignes:ecrire');
  const [tab, setTab] = useState<'arrets' | 'tarifs' | 'departs'>('arrets');
  const { data: line, error, loading, reload, setData } = useAsync((signal) => api.get<Line>(`/lignes/${id}`, { signal }), [id]);
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (loading && !line) return <Loading />;
  if (!line) return null;
  const toggleActive = async () => { setData(await api.patch<Line>(`/lignes/${id}`, { active: !line.active })); };
  return (
    <>
      <PageHead title={`${line.code} — ${line.name}`} subtitle={`${line.stops.length} arrêts`}>
        <Badge tone={line.active ? 'ok' : 'neutral'}>{line.active ? 'Active' : 'Inactive'}</Badge>
        {canWrite && <Button onClick={() => void toggleActive()}>{line.active ? 'Désactiver' : 'Réactiver'}</Button>}
        <Link className="btn" to="/lignes">Toutes les lignes</Link>
      </PageHead>
      <Tabs label="Détail de la ligne" value={tab} onChange={setTab} tabs={[{ id: 'arrets', label: 'Arrêts' }, { id: 'tarifs', label: 'Tarifs' }, { id: 'departs', label: 'Départs' }]} />
      <div className="card">
        {tab === 'arrets' && <StopsTab line={line} canWrite={canWrite} onChange={reload} />}
        {tab === 'tarifs' && <FaresTab line={line} canWrite={canWrite} onChange={reload} />}
        {tab === 'departs' && <TripsTab line={line} canWrite={canWrite} />}
      </div>
    </>
  );
}

function StopsTab({ line, canWrite, onChange }: { line: Line; canWrite: boolean; onChange: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const act = async (fn: () => Promise<unknown>) => { setError(undefined); try { await fn(); onChange(); } catch (e) { setError(errorMessage(e)); } };
  return (
    <div className="stack">
      {error && <Alert>{error}</Alert>}
      <ol style={{ margin: 0, paddingLeft: 'var(--sp-5)' }}>
        {line.stops.map((s) => (
          <li key={s.id} style={{ padding: 'var(--sp-2) 0' }}>
            <span className="row between"><strong>{s.name}</strong>
              {canWrite && <span className="row">
                <Button sm onClick={() => { const n = window.prompt("Nouveau nom de l'arrêt", s.name); if (n && n.trim().length >= 2) void act(() => api.patch(`/lignes/${line.id}/arrets/${s.id}`, { name: n.trim() })); }}>Renommer</Button>
                <Button sm variant="ghost" onClick={() => { if (window.confirm(`Retirer l'arrêt « ${s.name} » ?`)) void act(() => api.delete(`/lignes/${line.id}/arrets/${s.id}`)); }}>Retirer</Button>
              </span>}
            </span>
          </li>
        ))}
      </ol>
      {canWrite && (
        <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.post(`/lignes/${line.id}/arrets`, { name: name.trim() }); setName(''); }); }}>
          <Field label="Ajouter un arrêt à la fin">{(p) => <input {...p} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Button type="submit" variant="primary" icon="plus" disabled={name.trim().length < 2}>Ajouter</Button>
        </form>
      )}
    </div>
  );
}

function FaresTab({ line, canWrite, onChange }: { line: Line; canWrite: boolean; onChange: () => void }) {
  const stopName = (id: string) => line.stops.find((s) => s.id === id)?.name ?? '?';
  const [from, setFrom] = useState(line.stops[0]?.id ?? '');
  const [to, setTo] = useState(line.stops[1]?.id ?? '');
  const [category, setCategory] = useState<FareCategory>(ACTIVE_CATEGORIES[0]!);
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string>();
  const [q, setQ] = useState('');
  const pos = (id: string) => line.stops.find((s) => s.id === id)?.position ?? 0;
  const fares = [...line.fares].sort((a, b) => pos(a.fromStopId) - pos(b.fromStopId) || pos(a.toStopId) - pos(b.toStopId))
    .filter((f) => `${stopName(f.fromStopId)} ${stopName(f.toStopId)}`.toLowerCase().includes(q.toLowerCase()));
  const save = async (fromStopId: string, toStopId: string, cat: FareCategory, amount: number) => {
    setError(undefined);
    try { await api.put(`/lignes/${line.id}/tarifs`, { fromStopId, toStopId, category: cat, price: amount }); onChange(); } catch (e) { setError(errorMessage(e)); }
  };
  const priceNum = Number(price);
  return (
    <div className="stack">
      {error && <Alert>{error}</Alert>}
      {canWrite && (
        <form className="toolbar" onSubmit={(e) => { e.preventDefault(); void save(from, to, category, priceNum).then(() => setPrice('')); }}>
          <Field label="De">{(p) => <select {...p} className="input" value={from} onChange={(e) => setFrom(e.target.value)}>{line.stops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
          <Field label="À">{(p) => <select {...p} className="input" value={to} onChange={(e) => setTo(e.target.value)}>{line.stops.filter((s) => s.position > pos(from)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
          <Field label="Catégorie">{(p) => <select {...p} className="input" value={category} onChange={(e) => setCategory(e.target.value as FareCategory)}>{ACTIVE_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}</select>}</Field>
          <Field label="Prix (FCFA)">{(p) => <input {...p} className="input" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))} />}</Field>
          <Button type="submit" variant="primary" disabled={!from || !to || pos(to) <= pos(from) || !(priceNum >= 1)}>Enregistrer le tarif</Button>
        </form>
      )}
      <Field label="Filtrer par arrêt">{(p) => <input {...p} className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
      {fares.length === 0 ? <EmptyState title="Aucun tarif">Sans tarif, aucun ticket ne peut être vendu sur cette ligne.</EmptyState> : (
        <DataTable caption="Tarifs par trajet" rows={fares} rowKey={(f) => f.id} columns={[
          { key: 'route', header: 'Trajet', render: (f) => `${stopName(f.fromStopId)} → ${stopName(f.toStopId)}` },
          { key: 'cat', header: 'Catégorie', render: (f) => CATEGORY_LABELS[f.category] },
          { key: 'price', header: 'Prix', align: 'r', render: (f) => <strong className="num">{formatFcfa(f.price)}</strong> },
          { key: 'st', header: 'Statut', render: (f) => <Badge tone={f.active ? 'ok' : 'neutral'}>{f.active ? 'Actif' : 'Désactivé'}</Badge> },
          { key: 'a', header: '', className: 'actions', render: (f) => canWrite ? (
            <span className="row">
              <Button sm onClick={() => { const n = window.prompt('Nouveau prix (FCFA)', String(f.price)); const v = Number(n); if (n && v >= 1) void save(f.fromStopId, f.toStopId, f.category, v); }}>Modifier</Button>
              <Button sm variant="ghost" onClick={() => void api.patch(`/lignes/${line.id}/tarifs/${f.id}`, { active: !f.active }).then(onChange, (e) => setError(errorMessage(e)))}>{f.active ? 'Désactiver' : 'Activer'}</Button>
            </span>) : null },
        ]} />
      )}
    </div>
  );
}

function TripsTab({ line, canWrite }: { line: Line; canWrite: boolean }) {
  const [from, setFrom] = useState(toInputDate(startOfDay(new Date())));
  const [to, setTo] = useState(toInputDate(addDays(startOfDay(new Date()), 14)));
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const qs = new URLSearchParams({ lineId: line.id, from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59`).toISOString(), limit: '15', offset: String(offset) });
  const { data, error: loadError, loading, reload } = useAsync((signal) => api.get<TripPage>(`/departs?${qs}`, { signal }), [qs.toString()]);
  const setStatus = async (t: Trip, status: string) => { setError(undefined); try { await api.patch(`/departs/${t.id}`, { status }); reload(); } catch (e) { setError(errorMessage(e)); } };
  return (
    <div className="stack">
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <Field label="Du">{(p) => <input {...p} className="input" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} />}</Field>
        <Field label="Au">{(p) => <input {...p} className="input" type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); setOffset(0); }} />}</Field>
        {canWrite && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Planifier un départ</Button>}
      </div>
      {error && <Alert>{error}</Alert>}
      {loadError ? <ErrorBox message={loadError} onRetry={reload} /> : loading && !data ? <Loading />
        : !data || data.items.length === 0 ? <EmptyState title="Aucun départ sur cette période" />
        : <>
          <DataTable caption="Départs" rows={data.items} rowKey={(t) => t.id} columns={[
            { key: 'when', header: 'Départ', render: (t) => <strong>{formatDeparture(t.departureAt)}</strong> },
            { key: 'seats', header: 'Places', align: 'r', render: (t) => t.seats },
            { key: 'st', header: 'Statut', render: (t) => <Badge tone={tripTone(t.status)}>{TRIP_STATUS_LABELS[t.status]}</Badge> },
            { key: 'a', header: '', className: 'actions', render: (t) => canWrite ? (
              <select className="input" style={{ width: 'auto' }} aria-label={`Statut du départ ${formatDeparture(t.departureAt)}`} value={t.status} onChange={(e) => void setStatus(t, e.target.value)}>
                {TRIP_STATUSES.map((s) => <option key={s} value={s}>{TRIP_STATUS_LABELS[s]}</option>)}
              </select>) : null },
          ]} />
          <Pager total={data.total} limit={data.limit} offset={data.offset} onChange={setOffset} />
        </>}
      {creating && <NewTrip line={line} onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
    </div>
  );
}

function NewTrip({ line, onClose, onDone }: { line: Line; onClose: () => void; onDone: () => void }) {
  const [when, setWhen] = useState(toInputDateTime(new Date(Date.now() + 3600e3)));
  const [seats, setSeats] = useState('50');
  const [repeat, setRepeat] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      const days = Math.min(30, Math.max(1, Number(repeat) || 1));
      for (let i = 0; i < days; i++) {
        const d = new Date(when); d.setDate(d.getDate() + i);
        await api.post('/departs', { lineId: line.id, departureAt: d.toISOString(), seats: Number(seats) });
      }
      onDone();
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return (
    <Modal title="Planifier un départ" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <Alert>{error}</Alert>}
        <Field label="Date et heure">{(p) => <input {...p} className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}</Field>
        <Field label="Nombre de places">{(p) => <input {...p} className="input" inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value.replace(/\D/g, ''))} />}</Field>
        <Field label="Répéter chaque jour pendant (jours)" help="1 = un seul départ ; jusqu'à 30">{(p) => <input {...p} className="input" inputMode="numeric" value={repeat} onChange={(e) => setRepeat(e.target.value.replace(/\D/g, ''))} />}</Field>
        <div className="row"><Button type="submit" variant="primary" disabled={busy || !when || !(Number(seats) >= 1 && Number(seats) <= 100)}>{busy ? 'Planification…' : 'Planifier'}</Button><Button onClick={onClose}>Annuler</Button></div>
      </form>
    </Modal>
  );
}
