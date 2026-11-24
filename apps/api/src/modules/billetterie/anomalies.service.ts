import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AnomalyKind, ListAnomaliesQuery } from '@transport/shared';
import { DbService } from '../../database/db.service';
import { AuditService } from '../audit';

export interface AnomalyEntry { tenantId: string; kind: AnomalyKind; deviceId?: string; ticketId?: string; tripId?: string; detail?: Record<string, unknown> }
export interface AnomalyView {
  id: number; kind: string; status: string; deviceId: string | null; ticketId: string | null; tripId: string | null;
  detail: Record<string, unknown>; createdAt: Date; handledAt: Date | null; note: string | null;
}
interface Row { id: string; kind: string; status: string; device_id: string | null; ticket_id: string | null; trip_id: string | null; detail: Record<string, unknown>; created_at: Date; handled_at: Date | null; note: string | null }
const COLS = 'id, kind, status, device_id, ticket_id, trip_id, detail, created_at, handled_at, note';
const toView = (r: Row): AnomalyView => ({ id: Number(r.id), kind: r.kind, status: r.status, deviceId: r.device_id, ticketId: r.ticket_id, tripId: r.trip_id, detail: r.detail, createdAt: r.created_at, handledAt: r.handled_at, note: r.note });

@Injectable()
export class AnomaliesService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async record(c: PoolClient, e: AnomalyEntry): Promise<void> {
    await c.query('INSERT INTO anomalies (tenant_id, kind, device_id, ticket_id, trip_id, detail) VALUES ($1, $2, $3, $4, $5, $6)', [
      e.tenantId, e.kind, e.deviceId ?? null, e.ticketId ?? null, e.tripId ?? null, JSON.stringify(e.detail ?? {}),
    ]);
  }

  list(tenantId: string, q: ListAnomaliesQuery): Promise<{ items: AnomalyView[]; total: number; limit: number; offset: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      const where = 'WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR kind = $2)';
      const params = [q.status ?? null, q.kind ?? null];
      const total = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM anomalies ${where}`, params)).rows[0]!.n);
      const { rows } = await c.query<Row>(`SELECT ${COLS} FROM anomalies ${where} ORDER BY id DESC LIMIT $3 OFFSET $4`, [...params, q.limit, q.offset]);
      return { items: rows.map(toView), total, limit: q.limit, offset: q.offset };
    });
  }

  /** Chiffres du bandeau « rapport d'anomalies ». */
  summary(tenantId: string): Promise<{ open: number; byKind: Record<string, number>; pendingValidations: number; pendingValidationsOver48h: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      const kinds = (await c.query<{ kind: string; n: string }>("SELECT kind, count(*) AS n FROM anomalies WHERE status = 'ouverte' GROUP BY kind")).rows;
      const pend = (await c.query<{ n: string; old: string }>(
        "SELECT count(*) AS n, count(*) FILTER (WHERE scanned_at_corrected < now() - interval '48 hours') AS old FROM validations WHERE result = 'en_attente'",
      )).rows[0]!;
      return {
        open: kinds.reduce((a, k) => a + Number(k.n), 0),
        byKind: Object.fromEntries(kinds.map((k) => [k.kind, Number(k.n)])),
        pendingValidations: Number(pend.n),
        pendingValidationsOver48h: Number(pend.old),
      };
    });
  }

  handle(tenantId: string, userId: string, id: number, note?: string): Promise<AnomalyView> {
    return this.db.withTenant(tenantId, async (c) => {
      const row = (await c.query<Row>(
        `UPDATE anomalies SET status = 'traitee', handled_by = $2, handled_at = now(), note = $3 WHERE id = $1 RETURNING ${COLS}`, [id, userId, note ?? null],
      )).rows[0];
      if (!row) throw new NotFoundException('Anomalie introuvable');
      await this.audit.record({ tenantId, userId, action: 'anomaly.handled', objectType: 'anomaly', objectId: String(id), after: { note } }, c);
      return toView(row);
    });
  }
}
