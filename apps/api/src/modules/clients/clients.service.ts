import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateClientInput, ListClientsQuery, UpdateClientInput } from '@transport/shared';
import type { PoolClient } from 'pg';
import { DbService } from '../../database/db.service';
import { isUniqueViolation } from '../../database/pg-errors';

export interface ClientView { id: string; fullName: string; phone: string; email: string | null; createdAt: Date }
interface ClientRow { id: string; full_name: string; phone: string; email: string | null; created_at: Date }
const COLS = 'id, full_name, phone, email, created_at';
const toView = (r: ClientRow): ClientView => ({ id: r.id, fullName: r.full_name, phone: r.phone, email: r.email, createdAt: r.created_at });
const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

@Injectable()
export class ClientsService {
  constructor(private readonly db: DbService) {}

  async exists(c: PoolClient, id: string): Promise<boolean> {
    return ((await c.query('SELECT 1 FROM clients WHERE id = $1', [id])).rowCount ?? 0) > 0;
  }

  list(tenantId: string, q: ListClientsQuery): Promise<{ items: ClientView[]; total: number; limit: number; offset: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      const name = q.q ? `%${escapeLike(q.q)}%` : null;
      const phone = q.q ? `%${escapeLike(q.q.replace(/[\s.-]/g, ''))}%` : null;
      const where = `($1::text IS NULL OR lower(full_name) LIKE lower($1) ESCAPE '\\' OR phone LIKE $2 ESCAPE '\\')`;
      const total = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM clients WHERE ${where}`, [name, phone])).rows[0]!.n);
      const { rows } = await c.query<ClientRow>(
        `SELECT ${COLS} FROM clients WHERE ${where} ORDER BY lower(full_name), id LIMIT $3 OFFSET $4`,
        [name, phone, q.limit, q.offset],
      );
      return { items: rows.map(toView), total, limit: q.limit, offset: q.offset };
    });
  }

  get(tenantId: string, id: string): Promise<ClientView> {
    return this.db.withTenant(tenantId, async (c) => {
      const row = (await c.query<ClientRow>(`SELECT ${COLS} FROM clients WHERE id = $1`, [id])).rows[0];
      if (!row) throw new NotFoundException('Client introuvable');
      return toView(row);
    });
  }

  create(tenantId: string, input: CreateClientInput): Promise<ClientView> {
    return this.db.withTenant(tenantId, async (c) => {
      const existing = (await c.query<{ id: string }>('SELECT id FROM clients WHERE phone = $1', [input.phone])).rows[0];
      if (existing) throw new ConflictException({ message: 'Un client avec ce numéro existe déjà', clientId: existing.id });
      try {
        const { rows } = await c.query<ClientRow>(
          `INSERT INTO clients (tenant_id, full_name, phone, email) VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
          [tenantId, input.fullName, input.phone, input.email ?? null],
        );
        return toView(rows[0]!);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictException('Un client avec ce numéro existe déjà');
        throw e;
      }
    });
  }

  update(tenantId: string, id: string, input: UpdateClientInput): Promise<ClientView> {
    return this.db.withTenant(tenantId, async (c) => {
      const sets: string[] = [];
      const values: unknown[] = [id];
      const add = (col: string, v: unknown) => { values.push(v); sets.push(`${col} = $${values.length}`); };
      if (input.fullName !== undefined) add('full_name', input.fullName);
      if (input.phone !== undefined) add('phone', input.phone);
      if (input.email !== undefined) add('email', input.email);
      try {
        const row = (await c.query<ClientRow>(`UPDATE clients SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLS}`, values)).rows[0];
        if (!row) throw new NotFoundException('Client introuvable');
        return toView(row);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictException('Un client avec ce numéro existe déjà');
        throw e;
      }
    });
  }
}
