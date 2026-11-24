import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FareCategory, PaymentMethod, PAYMENT_METHODS } from '@transport/shared';
import { NetworkError, OfflineError, newUuid } from '@transport/offline';
import type { RefTrip } from '@transport/offline';
import { Icon } from '../../components/Icon';
import { Alert, Badge, Button, Field, Loading } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useCompany } from '../../lib/company';
import { formatDeparture, formatFcfa } from '../../lib/format';
import { CATEGORY_LABELS, PAYMENT_LABELS } from '../../lib/labels';
import { useOnline } from '../../lib/connectivity';
import { can } from '../../lib/nav';
import type { Poste, PosteState } from '../../lib/poste';
import { MAX_SEATS, blockedMessage, categoriesFor, clampSeats, defaultTrip, findFare, remainingSeats, sellableTrips } from '../../lib/sale';
import { useUser } from '../../lib/session';
import { ClientPicker, ClientLite } from './ClientPicker';
import { ShownTicket, TicketScreen } from './TicketScreen';

interface OnlineTicket {
  id: string; number: number; qr: string; seats: number; total: number; category: string; soldAt: string;
  trip: { lineName: string; departureAt: string } | null; from: { name: string | null }; to: { name: string | null };
  payment: { method: string };
}

const RETRY_DELAYS = [1200, 2500];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Vente rapide : tout sur un seul écran, du choix du départ au ticket. Ne dépend du réseau que pour le client et l'envoi. */
export function SaleScreen({ poste, state }: { poste: Poste | null; state: PosteState }) {
  const user = useUser();
  const online = useOnline();
  const company = useCompany();
  const catalog = state.catalog;
  const [lineId, setLineId] = useState('');
  const [tripId, setTripId] = useState('');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [category, setCategory] = useState<FareCategory>('plein_tarif');
  const [seats, setSeats] = useState(1);
  const [client, setClient] = useState<ClientLite | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('especes');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState<{ ticketId: string } | null>(null);
  const [shown, setShown] = useState<ShownTicket | null>(null);
  const [pending, setPending] = useState<Record<string, number>>({});
  const pendingKey = state.status?.pendingSales ?? 0;
  const attemptId = useRef<string | null>(null);

  // Ventes locales pas encore envoyées : elles occupent des places que le catalogue ne sait pas encore.
  useEffect(() => {
    let live = true;
    void poste?.engine.listSales().then((sales) => {
      if (!live) return;
      const m: Record<string, number> = {};
      for (const s of sales) if (s.status === 'en_attente') m[s.tripId] = (m[s.tripId] ?? 0) + s.seats;
      setPending(m);
    });
    return () => { live = false; };
  }, [poste, pendingKey]);

  const line = catalog?.lines.find((l) => l.id === lineId);
  const trips = useMemo(() => sellableTrips(catalog, lineId), [catalog, lineId]);
  const trip: RefTrip | undefined = trips.find((t) => t.id === tripId);
  const stops = line?.stops ?? [];
  const toStops = stops.filter((s) => s.position > (stops.find((x) => x.id === fromId)?.position ?? 0));
  const cats = categoriesFor(line, fromId, toId);
  const fare = findFare(line, fromId, toId, category);
  const remaining = trip ? remainingSeats(trip, pending[trip.id]) : 0;
  const total = fare ? fare.price * seats : 0;

  // Valeurs par défaut : première ligne, prochain horaire, premier → dernier arrêt.
  useEffect(() => {
    if (!catalog || lineId) return;
    const first = catalog.lines[0];
    if (first) setLineId(first.id);
  }, [catalog, lineId]);
  useEffect(() => {
    if (!line) return;
    setFromId((f) => (line.stops.some((s) => s.id === f) ? f : line.stops[0]?.id ?? ''));
    setToId((t) => (line.stops.some((s) => s.id === t) ? t : line.stops[line.stops.length - 1]?.id ?? ''));
  }, [line]);
  useEffect(() => {
    if (!trips.length) { setTripId(''); return; }
    if (!trips.some((t) => t.id === tripId)) setTripId(defaultTrip(trips, pending)?.id ?? '');
  }, [trips, tripId, pending]);
  useEffect(() => {
    if (!stops.length) return;
    const from = stops.find((s) => s.id === fromId);
    const to = stops.find((s) => s.id === toId);
    if (from && (!to || to.position <= from.position)) setToId(toStops[0]?.id ?? '');
  }, [fromId]);
  useEffect(() => { if (cats.length && !cats.includes(category)) setCategory(cats[0]!); }, [cats.join(), category]);
  useEffect(() => { setSeats((s) => clampSeats(s, Math.max(1, remaining))); }, [remaining]);

  const needsReference = method !== 'especes';
  const refOk = !needsReference || reference.trim().length >= 3;
  const status = state.status;
  const offlineBlocked = !online && !status?.canSell;
  const ready = !!trip && !!fare && remaining >= seats && refOk && !busy && !offlineBlocked && !!from_ok();
  function from_ok() { return fromId && toId; }

  const reset = useCallback(() => {
    setShown(null); setSeats(1); setClient(null); setMethod('especes'); setReference(''); setError(undefined); setUncertain(null);
    attemptId.current = null;
  }, []);

  const sellOnline = async (ticketId: string): Promise<OnlineTicket> => {
    let last: unknown;
    for (let i = 0; i <= RETRY_DELAYS.length; i++) {
      try {
        // Même identifiant à chaque essai : si la première réponse s'est perdue, le serveur renvoie la même vente.
        return await api.post<OnlineTicket>('/billetterie/ventes', {
          ticketId, tripId, fromStopId: fromId, toStopId: toId, category, seats,
          ...(client ? { clientId: client.id } : {}),
          payment: { method, ...(needsReference ? { reference: reference.trim() } : {}) },
        });
      } catch (e) {
        last = e;
        if (!(e instanceof NetworkError) || i === RETRY_DELAYS.length) throw e;
        await sleep(RETRY_DELAYS[i]!);
      }
    }
    throw last;
  };

  const sellLocal = async (): Promise<void> => {
    if (!poste || !trip || !line) return;
    const t = await poste.engine.sellOffline({
      tripId, fromStopId: fromId, toStopId: toId, category, seats, ...(client ? { clientId: client.id } : {}),
      payment: { method, ...(needsReference ? { reference: reference.trim() } : {}) },
    });
    setShown({
      ticketId: t.ticketId, number: t.number, qr: t.qr, lineName: line.name, from: stops.find((s) => s.id === fromId)!.name,
      to: stops.find((s) => s.id === toId)!.name, departureAt: trip.departureAt, seats, total: t.total, category, method, soldAt: t.soldAt, offline: true,
    });
    await poste.refresh();
    void poste.syncNow();
  };

  const submit = async (forceOffline = false) => {
    if (!ready && !forceOffline) return;
    setBusy(true); setError(undefined);
    try {
      if (forceOffline || !online) {
        await sellLocal();
      } else {
        const id = attemptId.current ?? (attemptId.current = newUuid());
        const t = await sellOnline(id);
        setShown({
          ticketId: t.id, number: t.number, qr: t.qr, lineName: t.trip?.lineName ?? line?.name ?? '', from: t.from.name ?? '', to: t.to.name ?? '',
          departureAt: t.trip?.departureAt ?? trip?.departureAt ?? '', seats: t.seats, total: t.total, category: t.category, method: t.payment.method, soldAt: t.soldAt, offline: false,
        });
        void poste?.reloadReference().catch(() => undefined);
      }
    } catch (e) {
      if (e instanceof NetworkError) {
        setUncertain({ ticketId: attemptId.current! });
        setError('Le réseau a coupé pendant l’encaissement. La vente a peut-être été enregistrée.');
      } else if (e instanceof OfflineError) {
        setError(e.message);
      } else {
        setError(errorMessage(e));
        attemptId.current = null;
      }
    } finally {
      setBusy(false);
    }
  };

  // Raccourcis clavier pour les postes d'ordinateur : + / − places, Ctrl+Entrée pour encaisser.
  useEffect(() => {
    if (shown) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest('input,textarea,select');
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); return; }
      if (typing) return;
      if (e.key === '+' || e.key === '=') setSeats((s) => clampSeats(s + 1, Math.max(1, remaining)));
      if (e.key === '-') setSeats((s) => clampSeats(s - 1, Math.max(1, remaining)));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (shown) return <TicketScreen ticket={shown} company={company?.name ?? ''} onNew={reset} />;
  if (!catalog) {
    return online
      ? <Loading label="Chargement des lignes et des tarifs…" />
      : <Alert tone="warn">Aucune donnée en cache sur cet appareil. Connectez-vous au réseau une première fois pour charger les lignes, tarifs et départs.</Alert>;
  }
  if (!catalog.lines.length) return <Alert tone="info">Aucune ligne n'est encore configurée. Le responsable d'exploitation doit en créer une.</Alert>;

  const ageMin = Math.round((Date.now() - catalog.fetchedAt) / 60000);

  return (
    <div className="sale">
      <div className="card stack">
        <h2>Départ</h2>
        <div className="grid-2">
          <Field label="Ligne">{(p) => <select {...p} className="input" value={lineId} onChange={(e) => setLineId(e.target.value)}>{catalog.lines.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}</select>}</Field>
          <Field label="Horaire" {...(trips.length === 0 ? { error: 'Aucun départ à vendre sur cette ligne' } : {})}>
            {(p) => (
              <select {...p} className="input" value={tripId} onChange={(e) => setTripId(e.target.value)} disabled={!trips.length}>
                {trips.map((t) => <option key={t.id} value={t.id}>{formatDeparture(t.departureAt)} — {remainingSeats(t, pending[t.id])} place(s){t.status === 'retarde' ? ' (retardé)' : ''}</option>)}
              </select>
            )}
          </Field>
          <Field label="Arrêt de départ">{(p) => <select {...p} className="input" value={fromId} onChange={(e) => setFromId(e.target.value)}>{stops.slice(0, -1).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
          <Field label="Arrêt d'arrivée">{(p) => <select {...p} className="input" value={toId} onChange={(e) => setToId(e.target.value)}>{toStops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
        </div>

        <div className="grid-2">
          <div className="field">
            <span className="lbl" id="seats-label">Nombre de places</span>
            <div className="stepper" role="group" aria-labelledby="seats-label">
              <Button aria-label="Une place de moins" disabled={seats <= 1} onClick={() => setSeats((s) => clampSeats(s - 1, Math.max(1, remaining)))}><Icon name="minus" /></Button>
              <output aria-live="polite" className="num" data-testid="seats">{seats}</output>
              <Button aria-label="Une place de plus" disabled={seats >= Math.min(MAX_SEATS, remaining)} onClick={() => setSeats((s) => clampSeats(s + 1, Math.max(1, remaining)))}><Icon name="plus" /></Button>
            </div>
            {trip && remaining <= 5 && <span className={remaining === 0 ? 'err' : 'help'}>{remaining === 0 ? 'Départ complet' : `Plus que ${remaining} place(s)`}</span>}
          </div>
          <div className="field">
            <span className="lbl" id="cat-label">Catégorie de tarif</span>
            <div className="seg" role="group" aria-labelledby="cat-label">
              {(cats.length ? cats : ['plein_tarif' as FareCategory]).map((c) => (
                <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}>{CATEGORY_LABELS[c]}</button>
              ))}
            </div>
          </div>
        </div>

        <ClientPicker online={online} canCreate={can(user, 'clients:ecrire')} value={client} onChange={setClient} />
      </div>

      <div className="card stack">
        <div className="price-box" aria-live="polite">
          <div className="muted small">{seats} place{seats > 1 ? 's' : ''}{fare ? ` × ${formatFcfa(fare.price)}` : ''}</div>
          <div className="amount" data-testid="price">{fare ? formatFcfa(total) : '—'}</div>
          {!fare && fromId && toId && <div className="err small" role="alert">Aucun tarif pour ce trajet</div>}
        </div>

        <div className="field">
          <span className="lbl" id="pay-label">Paiement</span>
          <div className="seg" role="group" aria-labelledby="pay-label">
            {PAYMENT_METHODS.map((m) => <button key={m} type="button" aria-pressed={method === m} onClick={() => setMethod(m)}>{PAYMENT_LABELS[m]}</button>)}
          </div>
        </div>
        {needsReference && (
          <Field label="Référence de la transaction" help={!online ? 'Hors ligne : le paiement sera marqué « à vérifier » puis contrôlé à la synchronisation.' : 'Saisie par le caissier (pas de vérification automatique).'}>
            {(p) => <input {...p} className="input" autoComplete="off" value={reference} onChange={(e) => setReference(e.target.value)} />}
          </Field>
        )}

        {error && (
          <Alert tone={uncertain ? 'warn' : 'error'}>
            {error}
            {uncertain && (
              <div className="stack-sm" style={{ marginTop: 'var(--sp-2)' }}>
                <span className="small">Réessayer est sans risque : la même vente n'est jamais enregistrée deux fois.</span>
                <div className="row">
                  <Button sm onClick={() => void submit()}>Réessayer</Button>
                  {status?.canSell && <Button sm onClick={() => void submit(true)}>Vendre hors ligne</Button>}
                </div>
                {status?.canSell && <span className="small">« Vendre hors ligne » crée un nouveau ticket : à n'utiliser que si le réseau est vraiment perdu. Vérifiez ensuite l'historique pour éviter un doublon.</span>}
              </div>
            )}
          </Alert>
        )}
        {offlineBlocked && <Alert tone="warn">{blockedMessage(status?.blockedReason)}</Alert>}

        <Button variant="primary" big disabled={!ready} onClick={() => void submit()}>
          {busy ? 'Encaissement…' : 'Encaisser'}
        </Button>
        <p className="muted small row" style={{ justifyContent: 'space-between' }}>
          <span><span className="kbd">+</span> <span className="kbd">−</span> places · <span className="kbd">Ctrl</span>+<span className="kbd">Entrée</span> encaisser</span>
          <span>{online ? <Badge tone="ok">En ligne</Badge> : <Badge tone="warn">Hors ligne</Badge>} {status?.canSell && !online ? `${status.rangeRemaining} numéros restants` : ''}</span>
        </p>
        {ageMin > 30 && <p className="muted small">Données chargées il y a {ageMin} min.</p>}
      </div>
    </div>
  );
}
