import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { FareCategory, Granularity, PaymentMethod, TicketStatus } from '@transport/shared';

/** Période : de `from` (inclus) à `toExclusive` (exclu), en instants UTC. */
export interface SalesFilter { from: Date; toExclusive: Date; lineId?: string }

export interface SalesTotals {
  tickets: number; seats: number; revenue: number;
  cancelledTickets: number; cancelledAmount: number;
  toVerifyTickets: number; toVerifyAmount: number;
  offlineTickets: number; offlineRevenue: number;
}
export interface SeriesPoint { date: string; tickets: number; seats: number; revenue: number }
export interface LineSales { lineId: string; tickets: number; seats: number; revenue: number }
export interface MethodSales { method: PaymentMethod; tickets: number; revenue: number; toVerifyAmount: number }
export interface CategorySales { category: FareCategory; tickets: number; seats: number; revenue: number }
export interface TripSales { tripId: string; tickets: number; soldSeats: number; revenue: number }
export interface JournalRow {
  number: number; soldAt: Date; lineId: string; tripId: string; fromStopId: string; toStopId: string; category: FareCategory;
  seats: number; unitPrice: number; total: number; status: TicketStatus; offline: boolean; cancelReason: string | null;
  method: PaymentMethod; reference: string | null; paymentStatus: string;
}

const n = (v: unknown) => Number(v);
const INTERVAL: Record<Granularity, [string, string]> = { jour: ['day', '1 day'], semaine: ['week', '1 week'], mois: ['month', '1 month'] };
// Une « recette » = un billet non annulé, rattaché à la date de sa vente. Les annulations sont comptées à part.
const WHERE = 't.sold_at >= $1 AND t.sold_at < $2 AND ($3::uuid IS NULL OR t.line_id = $3)';
const args = (f: SalesFilter) => [f.from, f.toExclusive, f.lineId ?? null];

/** Calculs sur les billets et les paiements, à partir de la base. Utilisé par le module des rapports. */
@Injectable()
export class SalesStatsService {
  async totals(c: PoolClient, f: SalesFilter): Promise<SalesTotals> {
    const r = (await c.query(
      `SELECT
         count(*) FILTER (WHERE t.status <> 'annule') AS tickets,
         coalesce(sum(t.seats) FILTER (WHERE t.status <> 'annule'), 0) AS seats,
         coalesce(sum(t.total_xof) FILTER (WHERE t.status <> 'annule'), 0) AS revenue,
         count(*) FILTER (WHERE t.status = 'annule') AS cancelled_tickets,
         coalesce(sum(t.total_xof) FILTER (WHERE t.status = 'annule'), 0) AS cancelled_amount,
         count(*) FILTER (WHERE t.status <> 'annule' AND p.status = 'a_verifier') AS to_verify_tickets,
         coalesce(sum(t.total_xof) FILTER (WHERE t.status <> 'annule' AND p.status = 'a_verifier'), 0) AS to_verify_amount,
         count(*) FILTER (WHERE t.status <> 'annule' AND t.offline) AS offline_tickets,
         coalesce(sum(t.total_xof) FILTER (WHERE t.status <> 'annule' AND t.offline), 0) AS offline_revenue
       FROM tickets t JOIN payments p ON p.ticket_id = t.id WHERE ${WHERE}`, args(f),
    )).rows[0];
    return {
      tickets: n(r.tickets), seats: n(r.seats), revenue: n(r.revenue), cancelledTickets: n(r.cancelled_tickets), cancelledAmount: n(r.cancelled_amount),
      toVerifyTickets: n(r.to_verify_tickets), toVerifyAmount: n(r.to_verify_amount), offlineTickets: n(r.offline_tickets), offlineRevenue: n(r.offline_revenue),
    };
  }

  /** Une ligne par jour, semaine (lundi) ou mois, y compris les périodes sans vente (pour les graphiques). */
  async series(c: PoolClient, f: SalesFilter, granularity: Granularity): Promise<SeriesPoint[]> {
    const [unit, step] = INTERVAL[granularity];
    const { rows } = await c.query(
      `WITH buckets AS (
         SELECT generate_series(date_trunc($4, ($1::timestamptz AT TIME ZONE 'UTC')), (($2::timestamptz AT TIME ZONE 'UTC') - interval '1 second'), $5::interval) AS d
       ), agg AS (
         SELECT date_trunc($4, (t.sold_at AT TIME ZONE 'UTC')) AS d, count(*) AS tickets, sum(t.seats) AS seats, sum(t.total_xof) AS revenue
         FROM tickets t WHERE t.status <> 'annule' AND ${WHERE} GROUP BY 1
       )
       SELECT to_char(b.d, 'YYYY-MM-DD') AS date, coalesce(a.tickets, 0) AS tickets, coalesce(a.seats, 0) AS seats, coalesce(a.revenue, 0) AS revenue
       FROM buckets b LEFT JOIN agg a ON a.d = b.d ORDER BY b.d`,
      [...args(f), unit, step],
    );
    return rows.map((r) => ({ date: r.date, tickets: n(r.tickets), seats: n(r.seats), revenue: n(r.revenue) }));
  }

  async byLine(c: PoolClient, f: SalesFilter): Promise<LineSales[]> {
    const { rows } = await c.query(
      `SELECT t.line_id, count(*) AS tickets, sum(t.seats) AS seats, sum(t.total_xof) AS revenue FROM tickets t
       WHERE t.status <> 'annule' AND ${WHERE} GROUP BY t.line_id`, args(f),
    );
    return rows.map((r) => ({ lineId: r.line_id, tickets: n(r.tickets), seats: n(r.seats), revenue: n(r.revenue) }));
  }

  async byMethod(c: PoolClient, f: SalesFilter): Promise<MethodSales[]> {
    const { rows } = await c.query(
      `SELECT p.method, count(*) AS tickets, sum(t.total_xof) AS revenue,
              coalesce(sum(t.total_xof) FILTER (WHERE p.status = 'a_verifier'), 0) AS to_verify
       FROM tickets t JOIN payments p ON p.ticket_id = t.id WHERE t.status <> 'annule' AND ${WHERE} GROUP BY p.method ORDER BY revenue DESC`, args(f),
    );
    return rows.map((r) => ({ method: r.method, tickets: n(r.tickets), revenue: n(r.revenue), toVerifyAmount: n(r.to_verify) }));
  }

  async byCategory(c: PoolClient, f: SalesFilter): Promise<CategorySales[]> {
    const { rows } = await c.query(
      `SELECT t.category, count(*) AS tickets, sum(t.seats) AS seats, sum(t.total_xof) AS revenue FROM tickets t
       WHERE t.status <> 'annule' AND ${WHERE} GROUP BY t.category ORDER BY revenue DESC`, args(f),
    );
    return rows.map((r) => ({ category: r.category, tickets: n(r.tickets), seats: n(r.seats), revenue: n(r.revenue) }));
  }

  /** Places vendues et recettes par départ, quelle que soit la date de vente (pour le taux de remplissage). */
  async tripStats(c: PoolClient, tripIds: string[]): Promise<Map<string, TripSales>> {
    if (tripIds.length === 0) return new Map();
    const { rows } = await c.query(
      `SELECT trip_id, count(*) AS tickets, sum(seats) AS seats, sum(total_xof) AS revenue FROM tickets WHERE status <> 'annule' AND trip_id = ANY($1) GROUP BY trip_id`, [tripIds],
    );
    return new Map(rows.map((r) => [r.trip_id, { tripId: r.trip_id, tickets: n(r.tickets), soldSeats: n(r.seats), revenue: n(r.revenue) }]));
  }

  async journalCount(c: PoolClient, f: SalesFilter): Promise<number> {
    return n((await c.query(`SELECT count(*) AS n FROM tickets t WHERE ${WHERE}`, args(f))).rows[0].n);
  }

  /** Journal des ventes (tous les billets de la période, annulés compris) pour la comptabilité. */
  async journal(c: PoolClient, f: SalesFilter, limit: number): Promise<JournalRow[]> {
    const { rows } = await c.query(
      `SELECT t.number, t.sold_at, t.line_id, t.trip_id, t.from_stop_id, t.to_stop_id, t.category, t.seats, t.unit_price_xof, t.total_xof,
              t.status, t.offline, t.cancel_reason, p.method, p.reference, p.status AS pay_status
       FROM tickets t JOIN payments p ON p.ticket_id = t.id WHERE ${WHERE} ORDER BY t.number LIMIT $4`, [...args(f), limit],
    );
    return rows.map((r) => ({
      number: r.number, soldAt: r.sold_at, lineId: r.line_id, tripId: r.trip_id, fromStopId: r.from_stop_id, toStopId: r.to_stop_id,
      category: r.category, seats: r.seats, unitPrice: r.unit_price_xof, total: r.total_xof, status: r.status, offline: r.offline,
      cancelReason: r.cancel_reason, method: r.method, reference: r.reference, paymentStatus: r.pay_status,
    }));
  }
}
