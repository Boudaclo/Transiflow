import type { PoolClient } from 'pg';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateTripInput, ListTripsQuery, TripStatus, UpdateTripInput } from '@transport/shared';
import { DbService } from '../../database/db.service';
import { isUniqueViolation } from '../../database/pg-errors';
import { AuditService } from '../audit';

export interface TripView { id: string; lineId: string; lineCode: string; lineName: string; departureAt: Date; seats: number; status: TripStatus }
interface TripRow { id: string; line_id: string; code: string; name: string; departure_at: Date; seats: number; status: TripStatus }
const SELECT = `SELECT t.id, t.line_id, l.code, l.name, t.departure_at, t.seats, t.status FROM trips t JOIN lines l ON l.id = t.line_id`;
const toView = (r: TripRow): TripView => ({ id: r.id, lineId: r.line_id, lineCode: r.code, lineName: r.name, departureAt: r.departure_at, seats: r.seats, status: r.status });
const DUPLICATE = 'Un départ existe déjà à cette heure sur cette ligne';

export interface SaleTrip { id: string; lineId: string; departureAt: Date; seats: number; status: TripStatus }

@Injectable()
export class TripsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** Verrouille le départ le temps de la transaction : les ventes d'un même départ passent l'une après l'autre. */
  async lockForSale(c: PoolClient, id: string): Promise<SaleTrip | null> {
    const row = (await c.query<{ id: string; line_id: string; departure_at: Date; seats: number; status: TripStatus }>(
      'SELECT id, line_id, departure_at, seats, status FROM trips WHERE id = $1 FOR UPDATE', [id],
    )).rows[0];
    return row ? { id: row.id, lineId: row.line_id, departureAt: row.departure_at, seats: row.seats, status: row.status } : null;
  }

  /** Départs d'une période (données de référence des postes), plafonnés à 1000. */
  async window(c: PoolClient, from: Date, to: Date): Promise<TripView[]> {
    const { rows } = await c.query<TripRow>(`${SELECT} WHERE t.departure_at >= $1 AND t.departure_at <= $2 ORDER BY t.departure_at, t.id LIMIT 1000`, [from, to]);
    return rows.map(toView);
  }

  /** Départs non annulés d'une période (capacité pour le taux de remplissage). Plafonné pour protéger le serveur. */
  async capacityIn(c: PoolClient, from: Date, toExclusive: Date, lineId?: string): Promise<{ id: string; lineId: string; seats: number }[]> {
    const { rows } = await c.query<{ id: string; line_id: string; seats: number }>(
      `SELECT id, line_id, seats FROM trips WHERE departure_at >= $1 AND departure_at < $2 AND status <> 'annule' AND ($3::uuid IS NULL OR line_id = $3) LIMIT 50001`,
      [from, toExclusive, lineId ?? null],
    );
    if (rows.length > 50000) throw new ConflictException('Trop de départs sur la période : réduisez la période');
    return rows.map((r) => ({ id: r.id, lineId: r.line_id, seats: r.seats }));
  }

  /** Page de départs d'une période, tous statuts. */
  async pageIn(c: PoolClient, from: Date, toExclusive: Date, lineId: string | undefined, limit: number, offset: number): Promise<{ items: TripView[]; total: number }> {
    const where = 'WHERE t.departure_at >= $1 AND t.departure_at < $2 AND ($3::uuid IS NULL OR t.line_id = $3)';
    const params = [from, toExclusive, lineId ?? null];
    const total = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM trips t ${where}`, params)).rows[0]!.n);
    const { rows } = await c.query<TripRow>(`${SELECT} ${where} ORDER BY t.departure_at, t.id LIMIT $4 OFFSET $5`, [...params, limit, offset]);
    return { items: rows.map(toView), total };
  }

  async describe(c: PoolClient, ids: string[]): Promise<Map<string, TripView>> {
    const { rows } = await c.query<TripRow>(`${SELECT} WHERE t.id = ANY($1)`, [ids]);
    return new Map(rows.map((r) => [r.id, toView(r)]));
  }

  create(tenantId: string, input: CreateTripInput, actorId: string): Promise<TripView> {
    return this.db.withTenant(tenantId, async (c) => {
      const line = (await c.query<{ active: boolean }>('SELECT active FROM lines WHERE id = $1', [input.lineId])).rows[0];
      if (!line) throw new NotFoundException('Ligne introuvable');
      if (!line.active) throw new ConflictException('Cette ligne est désactivée');
      let id: string;
      try {
        id = (await c.query<{ id: string }>('INSERT INTO trips (tenant_id, line_id, departure_at, seats) VALUES ($1, $2, $3, $4) RETURNING id', [tenantId, input.lineId, input.departureAt, input.seats])).rows[0]!.id;
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictException(DUPLICATE);
        throw e;
      }
      await this.audit.record({ tenantId, userId: actorId, action: 'trip.created', objectType: 'trip', objectId: id, after: input }, c);
      return toView((await c.query<TripRow>(`${SELECT} WHERE t.id = $1`, [id])).rows[0]!);
    });
  }

  list(tenantId: string, q: ListTripsQuery): Promise<{ items: TripView[]; total: number; limit: number; offset: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      const where = `WHERE ($1::uuid IS NULL OR t.line_id = $1) AND ($2::timestamptz IS NULL OR t.departure_at >= $2) AND ($3::timestamptz IS NULL OR t.departure_at <= $3)`;
      const params = [q.lineId ?? null, q.from ?? null, q.to ?? null];
      const total = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM trips t ${where}`, params)).rows[0]!.n);
      const { rows } = await c.query<TripRow>(`${SELECT} ${where} ORDER BY t.departure_at, t.id LIMIT $4 OFFSET $5`, [...params, q.limit, q.offset]);
      return { items: rows.map(toView), total, limit: q.limit, offset: q.offset };
    });
  }

  get(tenantId: string, id: string): Promise<TripView> {
    return this.db.withTenant(tenantId, async (c) => {
      const row = (await c.query<TripRow>(`${SELECT} WHERE t.id = $1`, [id])).rows[0];
      if (!row) throw new NotFoundException('Départ introuvable');
      return toView(row);
    });
  }

  update(tenantId: string, id: string, input: UpdateTripInput, actorId: string): Promise<TripView> {
    return this.db.withTenant(tenantId, async (c) => {
      const before = (await c.query<TripRow>(`${SELECT} WHERE t.id = $1 FOR UPDATE OF t`, [id])).rows[0];
      if (!before) throw new NotFoundException('Départ introuvable');
      const next = {
        status: input.status ?? before.status,
        departureAt: input.departureAt ?? before.departure_at,
        seats: input.seats ?? before.seats,
      };
      try {
        await c.query('UPDATE trips SET status = $2, departure_at = $3, seats = $4 WHERE id = $1', [id, next.status, next.departureAt, next.seats]);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictException(DUPLICATE);
        throw e;
      }
      await this.audit.record(
        {
          tenantId, userId: actorId, action: input.status && input.status !== before.status ? 'trip.status_changed' : 'trip.updated',
          objectType: 'trip', objectId: id,
          before: { status: before.status, departureAt: before.departure_at, seats: before.seats }, after: next,
        },
        c,
      );
      return toView((await c.query<TripRow>(`${SELECT} WHERE t.id = $1`, [id])).rows[0]!);
    });
  }
}
