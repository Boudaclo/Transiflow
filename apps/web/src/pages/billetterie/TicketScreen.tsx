import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { APP_NAME } from '../../config';
import { QrCode } from '../../components/QrCode';
import { Button, Badge } from '../../components/ui';
import { formatDeparture, formatDateTime, formatFcfa } from '../../lib/format';
import { CATEGORY_LABELS, PAYMENT_LABELS } from '../../lib/labels';

export interface ShownTicket {
  ticketId: string;
  number: number;
  qr: string;
  lineName: string;
  from: string;
  to: string;
  departureAt: string;
  seats: number;
  total: number;
  category: string;
  method: string;
  soldAt: string;
  /** Vendu hors ligne : en attente d'envoi au serveur. */
  offline: boolean;
}

/** Mise en page du ticket pour papier thermique 58 mm (zone imprimable ≈ 48 mm) : texte gras, QR vectoriel net. */
export function ThermalTicket({ t, company }: { t: ShownTicket; company: string }) {
  return (
    <div className="ticket-print" data-testid="ticket-print">
      <div className="t-title">{company}</div>
      <div>{APP_NAME}</div>
      <hr />
      <QrCode value={t.qr} quiet={2} />
      <div className="t-no">N° {t.number}</div>
      <hr />
      <div><strong>{t.from} → {t.to}</strong></div>
      <div>{t.lineName}</div>
      <div>Départ : {formatDeparture(t.departureAt)}</div>
      <div>{t.seats} place{t.seats > 1 ? 's' : ''} — {CATEGORY_LABELS[t.category] ?? t.category}</div>
      <div><strong>{formatFcfa(t.total)}</strong></div>
      <div>{PAYMENT_LABELS[t.method] ?? t.method}</div>
      <hr />
      <div style={{ fontSize: '9pt' }}>Vendu le {formatDateTime(t.soldAt)}</div>
      <div style={{ fontSize: '9pt' }}>Conservez ce ticket jusqu'à l'arrivée.</div>
    </div>
  );
}

export function printThermal(): void {
  const body = document.body;
  body.classList.add('printing-ticket');
  const done = () => { body.classList.remove('printing-ticket'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

/** Ticket affiché en plein écran après l'encaissement : QR, numéro, trajet, impression, nouvelle vente. */
export function TicketScreen({ ticket, company, onNew }: { ticket: ShownTicket; company: string; onNew: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest('input,textarea,select')) return;
      if (e.key === 'n' || e.key === 'N') onNew();
      if (e.key === 'p' || e.key === 'P') printThermal();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onNew]);
  return (
    <div className="card ticket-full" data-testid="ticket-screen">
      <div className="row" style={{ justifyContent: 'center' }}>
        <Badge tone="ok">Vente enregistrée</Badge>
        {ticket.offline && <Badge tone="warn">Sera envoyée au serveur dès le retour du réseau</Badge>}
      </div>
      <div className="qr"><QrCode value={ticket.qr} /></div>
      <div className="ticket-no num">N° {ticket.number}</div>
      <div>
        <strong style={{ fontSize: '1.2rem' }}>{ticket.from} → {ticket.to}</strong>
        <p className="muted">{ticket.lineName} · {formatDeparture(ticket.departureAt)}</p>
        <p>{ticket.seats} place{ticket.seats > 1 ? 's' : ''} · {CATEGORY_LABELS[ticket.category] ?? ticket.category} · <strong className="num">{formatFcfa(ticket.total)}</strong></p>
      </div>
      <div className="row no-print" style={{ justifyContent: 'center', width: '100%' }}>
        <Button icon="print" onClick={printThermal}>Imprimer (58 mm) <span className="kbd">P</span></Button>
        <Button variant="primary" icon="plus" onClick={onNew}>Nouvelle vente <span className="kbd" style={{ color: '#000' }}>N</span></Button>
      </div>
      {createPortal(<ThermalTicket t={ticket} company={company} />, document.body)}
    </div>
  );
}
