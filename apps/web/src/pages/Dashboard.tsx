import { useState } from 'react';
import { RevenueChart, BarList } from '../components/Charts';
import { Alert, Badge, Button, EmptyState, ErrorBox, Field, Loading, PageHead, StatCard } from '../components/ui';
import { useNetSummary } from '../components/StatusBanner';
import { api, errorMessage } from '../lib/api';
import { addDays, formatDateTime, formatFcfa, formatInt, formatPercent, startOfDay, toInputDate } from '../lib/format';
import { PAYMENT_LABELS, TICKET_STATUS_LABELS } from '../lib/labels';
import { can } from '../lib/nav';
import { useUser } from '../lib/session';
import { useAsync } from '../lib/useAsync';
import { Sheet, buildXlsx, saveBlob } from '../lib/xlsx';
import type { TicketRowView } from './billetterie/History';

interface Dash {
  period: { from: string; to: string; days: number; granularity: string; lineId: string | null };
  totals: { tickets: number; seats: number; revenue: number; cancelledTickets: number; cancelledAmount: number; toVerifyTickets: number; toVerifyAmount: number; offlineTickets: number; offlineRevenue: number; averageTicket: number };
  previous: { revenue: number; tickets: number; revenueEvolutionPct: number | null; ticketsEvolutionPct: number | null };
  series: { date: string; tickets: number; seats: number; revenue: number }[];
  fill: { trips: number; capacity: number; soldSeats: number; ratePct: number | null };
  lines: { lineId: string; code: string; name: string; revenue: number; tickets: number; fillRatePct: number | null }[];
  byPaymentMethod: { method: string; tickets: number; revenue: number; toVerifyAmount: number }[];
}
interface Anomaly { id: number; kind: string; status: string; createdAt: string; detail: Record<string, unknown> }
const ANOMALY_LABELS: Record<string, string> = {
  surreservation: 'Sur-réservation', depart_annule: 'Départ annulé', ecart_tarif: 'Écart de tarif', reference_dupliquee: 'Référence en double',
  vente_rejetee: 'Vente rejetée', validation_doublon: 'Double validation', validation_billet_annule: 'Billet annulé présenté', horloge_decalee: 'Horloge décalée',
};
const PRESETS = [
  { id: 'jour', label: "Aujourd'hui", days: 0 },
  { id: '7', label: '7 jours', days: 6 },
  { id: '30', label: '30 jours', days: 29 },
] as const;
const today = () => startOfDay(new Date());
const evo = (p: number | null) => (p === null ? null : <Badge tone={p >= 0 ? 'ok' : 'danger'}>{p >= 0 ? '+' : ''}{String(p).replace('.', ',')} % vs période précédente</Badge>);

export default function DashboardPage() {
  const user = useUser();
  const net = useNetSummary();
  const [from, setFrom] = useState(toInputDate(addDays(today(), -29)));
  const [to, setTo] = useState(toInputDate(today()));
  const [lineId, setLineId] = useState('');
  const [lineChoices, setLineChoices] = useState<{ id: string; label: string }[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const qs = new URLSearchParams({ from, to, ...(lineId ? { lineId } : {}) });
  const { data, error, loading, reload } = useAsync(async (signal) => {
    const d = await api.get<Dash>(`/tableau-de-bord?${qs}`, { signal });
    if (!lineId) setLineChoices(d.lines.map((l) => ({ id: l.lineId, label: `${l.code} — ${l.name}` })));
    return d;
  }, [qs.toString()]);
  const showActivity = can(user, 'billetterie:lire');
  const recent = useAsync((signal) => (showActivity ? api.get<{ items: TicketRowView[] }>('/billetterie/tickets?limit=8', { signal }) : Promise.resolve(undefined)), [showActivity, data?.totals.tickets]);
  const canAnomalies = can(user, 'administration:administrer');
  const anomalies = useAsync((signal) => (canAnomalies ? api.get<{ items: Anomaly[] }>('/anomalies?status=ouverte&limit=5', { signal }) : Promise.resolve(undefined)), [canAnomalies]);

  const preset = (days: number) => { setFrom(toInputDate(addDays(today(), -days))); setTo(toInputDate(today())); };
  const todayKey = toInputDate(new Date());
  const todayPoint = data?.series.find((s) => s.date.slice(0, 10) === todayKey);
  const rangeIncludesToday = to >= todayKey && from <= todayKey;

  const exportXlsx = async () => {
    if (!data) return;
    setExporting(true); setExportError(undefined);
    try {
      const sheets: Sheet[] = [
        { name: 'Résumé', rows: [['Période', `${data.period.from} au ${data.period.to}`], ['Recettes (FCFA)', data.totals.revenue], ['Tickets', data.totals.tickets], ['Places vendues', data.totals.seats], ['Ticket moyen (FCFA)', Math.round(data.totals.averageTicket)], ['Taux de remplissage (%)', data.fill.ratePct], ['Annulations', data.totals.cancelledTickets], ['Montant annulé (FCFA)', data.totals.cancelledAmount], ['Paiements à vérifier (FCFA)', data.totals.toVerifyAmount]] },
        { name: 'Évolution', rows: [['Date', 'Tickets', 'Places', 'Recettes (FCFA)'], ...data.series.map((s) => [s.date.slice(0, 10), s.tickets, s.seats, s.revenue])] },
        { name: 'Lignes', rows: [['Code', 'Ligne', 'Tickets', 'Recettes (FCFA)', 'Remplissage (%)'], ...data.lines.map((l) => [l.code, l.name, l.tickets, l.revenue, l.fillRatePct])] },
        { name: 'Paiements', rows: [['Mode', 'Tickets', 'Recettes (FCFA)', 'À vérifier (FCFA)'], ...data.byPaymentMethod.map((m) => [PAYMENT_LABELS[m.method] ?? m.method, m.tickets, m.revenue, m.toVerifyAmount])] },
      ];
      const bytes = buildXlsx(sheets);
      saveBlob(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `recettes_${data.period.from}_${data.period.to}.xlsx`);
    } catch (e) { setExportError(errorMessage(e)); } finally { setExporting(false); }
  };
  const exportCsv = async () => {
    setExporting(true); setExportError(undefined);
    try { const f = await api.download(`/tableau-de-bord/export?${qs}`); saveBlob(f.blob, f.filename); } catch (e) { setExportError(errorMessage(e)); } finally { setExporting(false); }
  };

  const activity = [
    ...(recent.data?.items ?? []).map((t) => ({ at: t.soldAt, tone: (t.status === 'annule' ? 'danger' : 'ok') as 'danger' | 'ok', text: t.status === 'annule' ? `Ticket n° ${t.number} annulé (${formatFcfa(t.total)})` : `Vente n° ${t.number} : ${t.from.name} → ${t.to.name}, ${formatFcfa(t.total)}`, tag: TICKET_STATUS_LABELS[t.status]! })),
    ...(anomalies.data?.items ?? []).map((a) => ({ at: a.createdAt, tone: 'warn' as const, text: `Anomalie : ${ANOMALY_LABELS[a.kind] ?? a.kind}`, tag: 'À traiter' })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 10);

  return (
    <>
      <PageHead title="Tableau de bord" subtitle="Recettes et activité de la compagnie">
        <Button icon="download" disabled={!data || exporting} onClick={exportXlsx}>Excel</Button>
        <Button icon="download" disabled={exporting} onClick={exportCsv}>CSV</Button>
        <Button icon="print" disabled={!data} onClick={() => window.print()}>PDF</Button>
      </PageHead>
      {exportError && <Alert tone="error">{exportError}</Alert>}

      <div className="card flat no-print" style={{ marginBottom: 'var(--sp-4)' }}>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <div className="field"><span className="lbl">Période</span><div className="row">{PRESETS.map((p) => <Button key={p.id} sm onClick={() => preset(p.days)}>{p.label}</Button>)}</div></div>
          <Field label="Du">{(p) => <input {...p} className="input" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />}</Field>
          <Field label="Au">{(p) => <input {...p} className="input" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />}</Field>
          <Field label="Ligne">{(p) => <select {...p} className="input" value={lineId} onChange={(e) => setLineId(e.target.value)}><option value="">Toutes les lignes</option>{lineChoices.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select>}</Field>
        </div>
      </div>

      {error ? <ErrorBox message={error} onRetry={reload} /> : loading && !data ? <Loading /> : data && (
        <>
          <p className="print-only">Recettes du {data.period.from} au {data.period.to}</p>
          <div className="stats">
            <StatCard label="Recettes du jour" value={<span className="num">{rangeIncludesToday ? formatFcfa(todayPoint?.revenue ?? 0) : '—'}</span>} hint={rangeIncludesToday ? `${todayPoint?.tickets ?? 0} ticket(s) aujourd'hui` : "Aujourd'hui est hors de la période"} />
            <StatCard label="Recettes de la période" value={<span className="num">{formatFcfa(data.totals.revenue)}</span>} hint={evo(data.previous.revenueEvolutionPct)} />
            <StatCard label="Tickets vendus" value={formatInt(data.totals.tickets)} hint={`${formatInt(data.totals.seats)} places · ticket moyen ${formatFcfa(data.totals.averageTicket)}`} />
            <StatCard label="Taux de remplissage" value={data.fill.ratePct === null ? '—' : formatPercent(data.fill.ratePct / 100)} hint={`${formatInt(data.fill.soldSeats)} / ${formatInt(data.fill.capacity)} places (${data.fill.trips} départs)`} />
            <StatCard label="En attente de synchronisation" value={formatInt(net.pending)} hint={net.pending ? 'Sur cet appareil, envoyées dès le retour du réseau' : 'Rien en attente sur cet appareil'} />
          </div>
          {(data.totals.toVerifyTickets > 0 || data.totals.cancelledTickets > 0) && (
            <div className="stack-sm" style={{ marginBottom: 'var(--sp-4)' }}>
              {data.totals.toVerifyTickets > 0 && <Alert tone="warn">{data.totals.toVerifyTickets} paiement(s) mobile à vérifier ({formatFcfa(data.totals.toVerifyAmount)}), inclus dans les recettes.</Alert>}
              {data.totals.cancelledTickets > 0 && <Alert tone="info">{data.totals.cancelledTickets} ticket(s) annulé(s) sur la période ({formatFcfa(data.totals.cancelledAmount)}), non comptés dans les recettes.</Alert>}
            </div>
          )}
          <div className="grid-main">
            <div className="card">
              <h2>Évolution des recettes</h2>
              {data.series.length === 0 ? <EmptyState title="Aucune vente sur la période" /> : (
                <RevenueChart title="Recettes par jour en FCFA" points={data.series.map((s) => ({ label: `${s.date.slice(8, 10)}/${s.date.slice(5, 7)}`, value: s.revenue }))} />
              )}
            </div>
            <div className="card">
              <h2>Top des lignes</h2>
              {data.lines.length === 0 ? <EmptyState title="Aucune ligne vendue" /> : (
                <BarList rows={[...data.lines].sort((a, b) => b.revenue - a.revenue).slice(0, 5).map((l) => ({ label: l.code, hint: l.name, value: l.revenue }))} />
              )}
            </div>
          </div>
          <div className="card" style={{ marginTop: 'var(--sp-4)' }}>
            <h2>Par mode de paiement</h2>
            <BarList rows={data.byPaymentMethod.map((m) => ({ label: PAYMENT_LABELS[m.method] ?? m.method, hint: `${m.tickets} ticket(s)`, value: m.revenue }))} />
          </div>
        </>
      )}

      {(showActivity || canAnomalies) && (
        <div className="card no-print" style={{ marginTop: 'var(--sp-4)' }}>
          <h2>Activité récente</h2>
          {activity.length === 0 ? <EmptyState title="Rien à afficher pour l'instant" /> : (
            <ul className="activity">
              {activity.map((a, i) => <li key={i}><Badge tone={a.tone}>{a.tag}</Badge><span className="grow">{a.text}<br /><span className="muted small">{formatDateTime(a.at)}</span></span></li>)}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
