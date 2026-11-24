import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ListAuditQuery } from '@transport/shared';
import { DbService } from '../../database/db.service';

export interface AuditEntry {
  tenantId: string | null;
  userId: string | null;
  action: string;
  objectType?: string;
  objectId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

export interface AuditView {
  id: number; userId: string | null; action: string; objectType: string | null; objectId: string | null;
  before: unknown; after: unknown; ip: string | null; createdAt: Date;
}
interface AuditRow {
  id: string; user_id: string | null; action: string; object_type: string | null; object_id: string | null;
  before: unknown; after: unknown; ip: string | null; created_at: Date;
}
const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  /** Avec `client` : écrit dans la même transaction que l'action auditée. */
  async record(e: AuditEntry, client?: PoolClient): Promise<void> {
    const write = async (c: PoolClient) => {
      await c.query(
        `INSERT INTO audit_logs (tenant_id, user_id, action, object_type, object_id, before, after, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          e.tenantId,
          e.userId,
          e.action,
          e.objectType ?? null,
          e.objectId ?? null,
          e.before === undefined ? null : JSON.stringify(e.before),
          e.after === undefined ? null : JSON.stringify(e.after),
          e.ip ?? null,
        ],
      );
    };
    if (client) await write(client);
    else await this.db.scope(e.tenantId, write);
  }

  /** Lecture du journal de la compagnie (le plus récent d'abord). Jamais de modification : le journal est immuable. */
  list(tenantId: string, q: ListAuditQuery): Promise<{ items: AuditView[]; total: number; limit: number; offset: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      const prefix = q.action ? `${escapeLike(q.action)}%` : null;
      const where = "WHERE ($1::text IS NULL OR action LIKE $1 ESCAPE '\\')";
      const total = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM audit_logs ${where}`, [prefix])).rows[0]!.n);
      const { rows } = await c.query<AuditRow>(
        `SELECT id, user_id, action, object_type, object_id, before, after, ip, created_at FROM audit_logs ${where} ORDER BY id DESC LIMIT $2 OFFSET $3`,
        [prefix, q.limit, q.offset],
      );
      return {
        total, limit: q.limit, offset: q.offset,
        items: rows.map((r) => ({
          id: Number(r.id), userId: r.user_id, action: r.action, objectType: r.object_type, objectId: r.object_id,
          before: r.before, after: r.after, ip: r.ip, createdAt: r.created_at,
        })),
      };
    });
  }
}
