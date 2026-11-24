import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  FareCategory, ListTicketsQuery, ListTripsQuery, PaymentMethod, SellTicketInput, TicketStatus,
  encodeTicketQr, packTicketPayload, QR_VERSION,
} from '@transport/shared';
import { DbService } from '../../database/db.service';
import { constraintOf, isUniqueViolation } from '../../database/pg-errors';
import { AuditService } from '../audit';
import { ClientsService } from '../clients';
import { LignesService, TripView, TripsService } from '../lignes';
import { SigningKeysService } from './signing-keys.service';

export interface TicketView {
  id: string;
  number: number;
  status: TicketStatus;
  trip: { id: string; lineCode: string; lineName: string; departureAt: Date } | null;
  from: { id: string; name: string | null };
  to: { id: string; name: string | null };
  category: FareCategory;
  seats: number;
  unitPrice: number;
  total: number;
  clientId: string | null;
  qr: string;
  soldAt: Date;
  soldBy: string;
  validatedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  payment: { method: PaymentMethod; reference: string | null; status: string };
  offline: boolean;
  deviceId: string | null;
}
export interface TripAvailability extends TripView { sold: number; remaining: number }

export interface TicketRow {
  id: string; number: number; line_id: string; trip_id: string; from_stop_id: string; to_stop_id: string;
  category: FareCategory; seats: number; unit_price_xof: number; total_xof: number; client_id: string | null;
  status: TicketStatus; qr: string; sold_by: string; sold_at: Date; validated_at: Date | null;
  cancelled_at: Date | null; cancel_reason: string | null;
  pay_method: PaymentMethod; pay_reference: string | null; pay_status: string; offline: boolean; device_id: string | null;
}
export const TICKET_SELECT = `SELECT t.id, t.number, t.line_id, t.trip_id, t.from_stop_id, t.to_stop_id, t.category, t.seats,
  t.unit_price_xof, t.total_xof, t.client_id, t.status, t.qr, t.sold_by, t.sold_at, t.validated_at, t.cancelled_at, t.cancel_reason,
  p.method AS pay_method, p.reference AS pay_reference, p.status AS pay_status, t.offline, t.device_id
  FROM tickets t JOIN payments p ON p.ticket_id = t.id`;

const SOLD = "status IN ('vendu', 'valide')";

@Injectable()
export class BilletterieService {
  constructor(
    private readonly db: DbService,
    private readonly keys: SigningKeysService,
    private readonly audit: AuditService,
    private readonly lignes: LignesService,
    private readonly trips: TripsService,
    private readonly clients: ClientsService,
  ) {}

  /** Vente en ligne. Rejouable : le même `ticketId` avec le même contenu renvoie le billet déjà créé. */
  sell(tenantId: string, userId: string, input: SellTicketInput): Promise<{ ticket: TicketView; created: boolean }> {
    return this.db.withTenant(tenantId, async (c) => {
      const trip = await this.trips.lockForSale(c, input.tripId);
      if (!trip) throw new NotFoundException('Départ introuvable');

      const existing = (await c.query<TicketRow>(`${TICKET_SELECT} WHERE t.id = $1`, [input.ticketId])).rows[0];
      if (existing) {
        if (!this.sameSale(existing, input)) throw new ConflictException('Cet identifiant de vente est déjà utilisé avec un autre contenu');
        return { ticket: (await this.toViews(c, [existing]))[0]!, created: false };
      }
      if (trip.status === 'annule') throw new ConflictException('Ce départ est annulé');

      const fare = await this.lignes.findActiveFare(c, trip.lineId, input.fromStopId, input.toStopId, input.category);
      if (!fare) throw new UnprocessableEntityException('Aucun tarif actif pour ce trajet et cette catégorie');
      if (input.clientId && !(await this.clients.exists(c, input.clientId))) throw new NotFoundException('Client introuvable');

      const sold = Number((await c.query<{ n: string }>(`SELECT coalesce(sum(seats), 0) AS n FROM tickets WHERE trip_id = $1 AND ${SOLD}`, [trip.id])).rows[0]!.n);
      if (sold + input.seats > trip.seats) throw new ConflictException(`Plus assez de places (restant : ${trip.seats - sold})`);

      const key = await this.keys.ensureServerKey(c, tenantId);
      const number = await this.allocateNumber(c, tenantId);
      const total = fare.price * input.seats;
      const payload = packTicketPayload({
        version: QR_VERSION, tenantId, keyId: key.id, ticketId: input.ticketId, number, tripId: trip.id,
        departureAt: Math.floor(trip.departureAt.getTime() / 1000), price: total, seats: input.seats,
      });
      const qr = encodeTicketQr(payload, await this.keys.sign(c, key.id, payload));

      try {
        await c.query(
          `INSERT INTO tickets (id, tenant_id, number, line_id, trip_id, from_stop_id, to_stop_id, category, seats, unit_price_xof, total_xof, client_id, signing_key_id, qr, sold_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [input.ticketId, tenantId, number, trip.lineId, trip.id, input.fromStopId, input.toStopId, input.category, input.seats, fare.price, total, input.clientId ?? null, key.id, qr, userId],
        );
        await c.query(
          'INSERT INTO payments (tenant_id, ticket_id, method, amount_xof, reference) VALUES ($1, $2, $3, $4, $5)',
          [tenantId, input.ticketId, input.payment.method, total, input.payment.reference ?? null],
        );
      } catch (e) {
        if (isUniqueViolation(e)) {
          if (constraintOf(e) === 'payments_reference_unique') throw new ConflictException('Cette référence de transaction est déjà utilisée');
          throw new ConflictException('Cet identifiant de vente est déjà utilisé');
        }
        throw e;
      }
      const row = (await c.query<TicketRow>(`${TICKET_SELECT} WHERE t.id = $1`, [input.ticketId])).rows[0]!;
      return { ticket: (await this.toViews(c, [row]))[0]!, created: true };
    });
  }

  list(tenantId: string, q: ListTicketsQuery): Promise<{ items: TicketView[]; total: number; limit: number; offset: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      const where = 'WHERE ($1::uuid IS NULL OR t.trip_id = $1) AND ($2::int IS NULL OR t.number = $2) AND ($3::text IS NULL OR t.status = $3) AND ($4::uuid IS NULL OR t.client_id = $4)';
      const params = [q.tripId ?? null, q.number ?? null, q.status ?? null, q.clientId ?? null];
      const total = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM tickets t ${where}`, params)).rows[0]!.n);
      const { rows } = await c.query<TicketRow>(`${TICKET_SELECT} ${where} ORDER BY t.number DESC LIMIT $5 OFFSET $6`, [...params, q.limit, q.offset]);
      return { items: await this.toViews(c, rows), total, limit: q.limit, offset: q.offset };
    });
  }

  get(tenantId: string, id: string): Promise<TicketView> {
    return this.db.withTenant(tenantId, async (c) => {
      const row = (await c.query<TicketRow>(`${TICKET_SELECT} WHERE t.id = $1`, [id])).rows[0];
      if (!row) throw new NotFoundException('Billet introuvable');
      return (await this.toViews(c, [row]))[0]!;
    });
  }

  /** Annulation avec justification obligatoire : le paiement est marqué remboursé, l'action est journalisée. */
  cancel(tenantId: string, userId: string, id: string, reason: string): Promise<TicketView> {
    return this.db.withTenant(tenantId, async (c) => {
      const t = (await c.query<{ id: string; number: number; status: TicketStatus; total_xof: number }>(
        'SELECT id, number, status, total_xof FROM tickets WHERE id = $1 FOR UPDATE', [id],
      )).rows[0];
      if (!t) throw new NotFoundException('Billet introuvable');
      if (t.status === 'annule') throw new ConflictException('Ce billet est déjà annulé');
      if (t.status === 'valide') throw new ConflictException('Un billet déjà validé ne peut pas être annulé');
      await c.query("UPDATE tickets SET status = 'annule', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1", [id, userId, reason]);
      await c.query("UPDATE payments SET status = 'rembourse' WHERE ticket_id = $1", [id]);
      await this.audit.record(
        { tenantId, userId, action: 'ticket.cancelled', objectType: 'ticket', objectId: id, before: { status: t.status }, after: { status: 'annule', number: t.number, total: t.total_xof, reason } },
        c,
      );
      const row = (await c.query<TicketRow>(`${TICKET_SELECT} WHERE t.id = $1`, [id])).rows[0]!;
      return (await this.toViews(c, [row]))[0]!;
    });
  }

  /** Confirme un paiement mobile saisi hors ligne (« à vérifier » vers « encaissé »). */
  verifyPayment(tenantId: string, userId: string, ticketId: string): Promise<TicketView> {
    return this.db.withTenant(tenantId, async (c) => {
      const p = (await c.query<{ status: string; method: string; reference: string | null }>('SELECT status, method, reference FROM payments WHERE ticket_id = $1 FOR UPDATE', [ticketId])).rows[0];
      if (!p) throw new NotFoundException('Billet introuvable');
      if (p.status !== 'a_verifier') throw new ConflictException('Ce paiement n\'est pas à vérifier');
      try {
        await c.query("UPDATE payments SET status = 'encaisse' WHERE ticket_id = $1", [ticketId]);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictException('Cette référence de transaction est déjà utilisée par un autre billet');
        throw e;
      }
      await this.audit.record({ tenantId, userId, action: 'payment.verified', objectType: 'ticket', objectId: ticketId, before: { status: p.status }, after: { status: 'encaisse', method: p.method, reference: p.reference } }, c);
      const row = (await c.query<TicketRow>(`${TICKET_SELECT} WHERE t.id = $1`, [ticketId])).rows[0]!;
      return (await this.toViews(c, [row]))[0]!;
    });
  }

  /** Départs avec places restantes (écran de vente). */
  async availability(tenantId: string, q: ListTripsQuery): Promise<{ items: TripAvailability[]; total: number; limit: number; offset: number }> {
    const page = await this.trips.list(tenantId, q);
    const counts = await this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ trip_id: string; n: string }>(
        `SELECT trip_id, sum(seats) AS n FROM tickets WHERE trip_id = ANY($1) AND ${SOLD} GROUP BY trip_id`, [page.items.map((t) => t.id)],
      );
      return new Map(rows.map((r) => [r.trip_id, Number(r.n)]));
    });
    return {
      ...page,
      items: page.items.map((t) => ({ ...t, sold: counts.get(t.id) ?? 0, remaining: t.seats - (counts.get(t.id) ?? 0) })),
    };
  }

  /** Réutilisé par le contrôle. */
  async toViews(c: PoolClient, rows: TicketRow[]): Promise<TicketView[]> {
    if (rows.length === 0) return [];
    const trips = await this.trips.describe(c, [...new Set(rows.map((r) => r.trip_id))]);
    const names = await this.lignes.stopNames(c, [...new Set(rows.flatMap((r) => [r.from_stop_id, r.to_stop_id]))]);
    return rows.map((r) => {
      const trip = trips.get(r.trip_id);
      return {
        id: r.id, number: r.number, status: r.status,
        trip: trip ? { id: trip.id, lineCode: trip.lineCode, lineName: trip.lineName, departureAt: trip.departureAt } : null,
        from: { id: r.from_stop_id, name: names.get(r.from_stop_id) ?? null },
        to: { id: r.to_stop_id, name: names.get(r.to_stop_id) ?? null },
        category: r.category, seats: r.seats, unitPrice: r.unit_price_xof, total: r.total_xof, clientId: r.client_id, qr: r.qr,
        soldAt: r.sold_at, soldBy: r.sold_by, validatedAt: r.validated_at, cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason,
        payment: { method: r.pay_method, reference: r.pay_reference, status: r.pay_status },
        offline: r.offline, deviceId: r.device_id,
      };
    });
  }

  private async allocateNumber(c: PoolClient, tenantId: string): Promise<number> {
    await c.query('INSERT INTO ticket_counters (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [tenantId]);
    const row = (await c.query<{ n: number }>('UPDATE ticket_counters SET next_number = next_number + 1 WHERE tenant_id = $1 RETURNING next_number - 1 AS n', [tenantId])).rows[0]!;
    return row.n;
  }

  private sameSale(t: TicketRow, i: SellTicketInput): boolean {
    return (
      t.trip_id === i.tripId && t.from_stop_id === i.fromStopId && t.to_stop_id === i.toStopId && t.category === i.category &&
      t.seats === i.seats && (t.client_id ?? null) === (i.clientId ?? null) &&
      t.pay_method === i.payment.method && (t.pay_reference ?? null) === (i.payment.reference ?? null)
    );
  }
}
