import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateTenantInput, UpdateCompanyInput } from '@transport/shared';
import { DbService } from '../../database/db.service';
import { isUniqueViolation } from '../../database/pg-errors';
import { AuditService } from '../audit';
import { UserView, UsersService } from '../auth';

export interface TenantView { id: string; name: string; slug: string; currency: string; active: boolean; createdAt: Date }
export interface CompanyView { id: string; name: string; slug: string; currency: string; logo: string | null }
interface TenantRow { id: string; name: string; slug: string; currency: string; active: boolean; created_at: Date }
const COLS = 'id, name, slug, currency, active, created_at';
const toView = (r: TenantRow): TenantView => ({ id: r.id, name: r.name, slug: r.slug, currency: r.currency, active: r.active, createdAt: r.created_at });

@Injectable()
export class TenantsService {
  constructor(private readonly db: DbService, private readonly users: UsersService, private readonly audit: AuditService) {}

  /** Crée la compagnie et son directeur dans une seule transaction. */
  create(input: CreateTenantInput, actorId: string): Promise<TenantView & { admin: UserView }> {
    return this.db.withPlatform(async (c) => {
      let row: TenantRow;
      try {
        row = (await c.query<TenantRow>(`INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING ${COLS}`, [input.name, input.slug])).rows[0]!;
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictException('Ce code de compagnie existe déjà');
        throw e;
      }
      const admin = await this.users.createWithClient(
        c, row.id, { email: input.adminEmail, fullName: input.adminName, password: input.adminPassword, roles: ['directeur'] }, actorId,
      );
      await this.audit.record(
        { tenantId: row.id, userId: actorId, action: 'tenant.created', objectType: 'tenant', objectId: row.id, after: { name: input.name, slug: input.slug } },
        c,
      );
      return { ...toView(row), admin };
    });
  }

  list(): Promise<TenantView[]> {
    return this.db.withPlatform(async (c) => (await c.query<TenantRow>(`SELECT ${COLS} FROM tenants ORDER BY created_at`)).rows.map(toView));
  }

  get(id: string): Promise<TenantView> {
    return this.db.withPlatform(async (c) => {
      const row = (await c.query<TenantRow>(`SELECT ${COLS} FROM tenants WHERE id = $1`, [id])).rows[0];
      if (!row) throw new NotFoundException('Compagnie introuvable');
      return toView(row);
    });
  }

  /** Paramètres de la compagnie de l'utilisateur connecté (lecture sous RLS). */
  getOwn(tenantId: string): Promise<CompanyView> {
    return this.db.withTenant(tenantId, async (c) => {
      const row = (await c.query<TenantRow & { logo: string | null }>(`SELECT ${COLS}, logo FROM tenants WHERE id = $1`, [tenantId])).rows[0];
      if (!row) throw new NotFoundException('Compagnie introuvable');
      return { id: row.id, name: row.name, slug: row.slug, currency: row.currency, logo: row.logo };
    });
  }

  updateOwn(tenantId: string, input: UpdateCompanyInput, actorId: string): Promise<CompanyView> {
    return this.db.withTenant(tenantId, async (c) => {
      const before = (await c.query<{ name: string; logo: string | null }>('SELECT name, logo FROM tenants WHERE id = $1 FOR UPDATE', [tenantId])).rows[0];
      if (!before) throw new NotFoundException('Compagnie introuvable');
      const name = input.name ?? before.name;
      const logo = input.logo === undefined ? before.logo : input.logo;
      await c.query('UPDATE tenants SET name = $2, logo = $3 WHERE id = $1', [tenantId, name, logo]);
      await this.audit.record(
        { tenantId, userId: actorId, action: 'tenant.updated', objectType: 'tenant', objectId: tenantId, before: { name: before.name, logo: before.logo ? 'oui' : 'non' }, after: { name, logo: logo ? 'oui' : 'non' } },
        c,
      );
      const row = (await c.query<TenantRow>(`SELECT ${COLS} FROM tenants WHERE id = $1`, [tenantId])).rows[0]!;
      return { id: row.id, name: row.name, slug: row.slug, currency: row.currency, logo };
    });
  }

  setActive(id: string, active: boolean, actorId: string): Promise<TenantView> {
    return this.db.withPlatform(async (c) => {
      const row = (await c.query<TenantRow>(`UPDATE tenants SET active = $2 WHERE id = $1 RETURNING ${COLS}`, [id, active])).rows[0];
      if (!row) throw new NotFoundException('Compagnie introuvable');
      if (!active) {
        await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL', [id]);
      }
      await this.audit.record(
        { tenantId: id, userId: actorId, action: active ? 'tenant.activated' : 'tenant.deactivated', objectType: 'tenant', objectId: id }, c,
      );
      return toView(row);
    });
  }
}
