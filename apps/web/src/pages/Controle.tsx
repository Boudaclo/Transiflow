import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { NetworkError, OfflineError, ApiError } from '@transport/offline';
import { Icon } from '../components/Icon';
import { Scanner } from '../components/Scanner';
import { Alert, Badge, Button, Field, PageHead } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useOnline } from '../lib/connectivity';
import { formatDeparture } from '../lib/format';
import { can } from '../lib/nav';
import { usePoste } from '../lib/poste';
import { ScanDisplay, ScanTicketInfo, scanToDisplay, signal } from '../lib/scan';
import { useUser } from '../lib/session';
import { PostePanel } from './billetterie/PostePanel';

interface ServerOutcome { result: string; firstValidatedAt?: string; ticket?: ScanTicketInfo }
interface Manifest { seatsSold: number; seatsValidated: number; seatsNotYetValidated: number }
const COOLDOWN_MS = 3500;

export default function ControlePage() {
  const user = useUser();
  const online = useOnline();
  const canValidate = can(user, 'controle:valider');
  const { poste, state } = usePoste('controle', canValidate);
  const [tripId, setTripId] = useState('');
  const [shown, setShown] = useState<ScanDisplay | null>(null);
  const [manual, setManual] = useState('');
  const [error, setError] = useState<string>();
  const [session, setSession] = useState<Record<string, number>>({});
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const last = useRef<{ code: string; at: number } | null>(null);
  const busy = useRef(false);
  const trips = (state.controlTrips?.trips ?? []).filter((t) => t.status !== 'annule').sort((a, b) => Date.parse(a.departureAt) - Date.parse(b.departureAt));

  // Départ en cours par défaut : le plus proche de l'heure actuelle.
  useEffect(() => {
    if (tripId && trips.some((t) => t.id === tripId)) return;
    const now = Date.now();
    const nearest = [...trips].sort((a, b) => Math.abs(Date.parse(a.departureAt) - now) - Math.abs(Date.parse(b.departureAt) - now))[0];
    setTripId(nearest?.id ?? '');
  }, [trips, tripId]);

  const loadManifest = useCallback(async () => {
    if (!tripId || !online) { setManifest(null); return; }
    try { setManifest(await api.get<Manifest>(`/controle/departs/${tripId}`)); } catch { setManifest(null); }
  }, [tripId, online]);
  useEffect(() => { void loadManifest(); }, [loadManifest]);

  const present = useCallback((d: ScanDisplay) => {
    signal(d.valid);
    setShown(d);
    if (d.valid) setSession((s) => ({ ...s, [tripId]: (s[tripId] ?? 0) + 1 }));
  }, [tripId]);

  const check = useCallback(async (input: { qr?: string; number?: number }) => {
    if (busy.current) return;
    busy.current = true; setError(undefined);
    try {
      const body = { ...(input.qr ? { qr: input.qr } : { number: input.number }), ...(tripId ? { tripId } : {}) };
      let outcome: ServerOutcome | undefined;
      if (online) {
        try { outcome = await api.post<ServerOutcome>('/controle/validations', body); } catch (e) { if (!(e instanceof NetworkError)) throw e; }
      }
      if (outcome) {
        present(scanToDisplay(outcome.result, outcome.ticket, outcome.firstValidatedAt));
        void loadManifest();
      } else if (input.qr && poste) {
        const local = await poste.engine.validateOffline({ qr: input.qr, ...(tripId ? { tripId } : {}) });
        present(scanToDisplay(local.result, local.ticket, local.firstValidatedAt, local.sousReserve));
        await poste.refresh();
        void poste.syncNow();
      } else {
        setError(input.qr ? "Pas de réseau et ce poste n'est pas activé pour contrôler hors ligne." : 'La saisie manuelle du numéro demande une connexion.');
      }
    } catch (e) {
      if (e instanceof OfflineError) setError(e.message);
      else if (e instanceof ApiError && e.status === 404) present(scanToDisplay('inconnu'));
      else setError(errorMessage(e));
    } finally {
      busy.current = false;
    }
  }, [online, poste, present, tripId, loadManifest]);

  const onCode = useCallback((code: string) => {
    const l = last.current;
    if (l && l.code === code && Date.now() - l.at < COOLDOWN_MS) return; // même QR toujours devant la caméra
    last.current = { code, at: Date.now() };
    void check({ qr: code });
  }, [check]);

  // Un résultat valide se referme tout seul ; un refus reste affiché jusqu'au toucher.
  useEffect(() => {
    if (!shown?.valid) return;
    const t = setTimeout(() => setShown(null), 1600);
    return () => clearTimeout(t);
  }, [shown]);

  const onManual = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(manual);
    if (Number.isInteger(n) && n > 0) { void check({ number: n }); setManual(''); }
  };

  const trip = trips.find((t) => t.id === tripId);
  const validatedHere = session[tripId] ?? 0;
  const pending = state.status?.pendingValidations ?? 0;

  return (
    <>
      <PageHead title="Contrôle" subtitle="Scannez les tickets à la montée" />
      {canValidate && <PostePanel poste={poste} state={state} kind="controle" />}
      <div className="grid-main">
        <div className="stack">
          <div className="card stack">
            <Field label="Départ en cours" {...(trips.length === 0 ? { help: online ? 'Chargement des départs…' : 'Aucun départ en cache : connectez-vous une première fois.' } : {})}>
              {(p) => <select {...p} className="input" value={tripId} onChange={(e) => setTripId(e.target.value)}>
                <option value="">Tous les départs</option>
                {trips.map((t) => <option key={t.id} value={t.id}>{t.lineCode} · {formatDeparture(t.departureAt)}</option>)}
              </select>}
            </Field>
            {canValidate ? <Scanner onCode={onCode} paused={!!shown} /> : <Alert tone="info">Votre rôle permet de consulter le contrôle, pas de valider.</Alert>}
            {error && <Alert tone="error">{error}</Alert>}
          </div>
        </div>
        <div className="stack">
          <div className="card stat" data-testid="counter">
            <span className="label">Validations — {trip ? `${trip.lineCode} ${formatDeparture(trip.departureAt)}` : 'tous départs'}</span>
            <span className="value">{manifest ? manifest.seatsValidated : validatedHere}{manifest ? <span className="muted" style={{ fontSize: '1rem' }}> / {manifest.seatsSold} places</span> : null}</span>
            <span className="hint">{manifest ? `${manifest.seatsNotYetValidated} place(s) pas encore validée(s)` : `${validatedHere} validée(s) sur cet appareil`}</span>
            {pending > 0 && <Badge tone="warn">{pending} validation(s) à envoyer</Badge>}
          </div>
          {canValidate && (
            <form className="card stack" onSubmit={onManual}>
              <h2>Saisie manuelle</h2>
              <Field label="Numéro du ticket" help={online ? 'En secours si le QR ne se lit pas.' : 'Réseau requis pour la saisie manuelle.'}>
                {(p) => <input {...p} className="input" inputMode="numeric" value={manual} onChange={(e) => setManual(e.target.value.replace(/\D/g, ''))} disabled={!online} />}
              </Field>
              <Button type="submit" variant="primary" disabled={!online || !manual}>Valider ce numéro</Button>
            </form>
          )}
        </div>
      </div>
      {shown && (
        <div className={`scan-result ${shown.tone}`} role="alertdialog" aria-live="assertive" aria-label={shown.title} onClick={() => setShown(null)} data-testid="scan-result">
          <Icon name={shown.valid ? 'check' : shown.tone === 'warn' ? 'alert' : 'x'} size={110} />
          <div className="big">{shown.title}</div>
          {shown.detail && <div className="detail">{shown.detail}</div>}
          {shown.sub && <div className="detail" style={{ opacity: 0.9 }}>{shown.sub}</div>}
          <button type="button" className="btn" onClick={() => setShown(null)}>Continuer</button>
        </div>
      )}
    </>
  );
}
