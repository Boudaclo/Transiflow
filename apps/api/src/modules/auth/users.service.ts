import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { PoolClient } from 'pg';
import { Role, isRole } from '@transport/shared';
import { DbService } from '../../database/db.service';
import { isUniqueViolation } from '../../database/pg-errors';
import { AuditService } from '../audit';

export interface UserView {
  id: string;
  email: string;
  fullName: string;
  active: boolean;
  roles: Role[];
}
interface UserRow {
  id: string;
  email: string;
  full_name: string;
  active: boolean;
  roles: string[];
}
interface NewUser {
  email: string;
  fullName: string;
  password: string;
  roles: Role[];
}

const SELECT_USER = `SELECT u.id, u.email, u.full_name, u.active,
  array(SELECT ur.role_code FROM user_roles ur WHERE ur.user_id = u.id ORDER BY ur.role_code) AS roles
  FROM users u`;
const toView = (r: UserRow): UserView => ({
  id: r.id, email: r.email, fullName: r.full_name, active: r.active, roles: r.roles.filter(isRole) as Role[],
});

@Injectable()
export class UsersService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** tenantId null = compte plateforme. Utilisable dans la transaction d'un autre module (création d'une compagnie). */
  async createWithClient(c: PoolClient, tenantId: string | null, input: NewUser, actorId: string | null): Promise<UserView> {
    const hash = await argon2.hash(input.password, { type: argon2.argon2id });
    let id: string;
    try {
      const { rows } = await c.query<{ id: string }>(
        'INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
        [tenantId, input.email, input.fullName, hash],
      );
      id = rows[0]!.id;
      for (const role of input.roles) await c.query('INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)', [id, role]);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Cette adresse e-mail est déjà utilisée');
      throw e;
    }
    await this.audit.record(
      { tenantId, userId: actorId, action: 'user.created', objectType: 'user', objectId: id, after: { email: input.email, roles: input.roles } },
      c,
    );
    return { id, email: input.email, fullName: input.fullName, active: true, roles: input.roles };
  }

  create(tenantId: string, input: NewUser, actorId: string): Promise<UserView> {
    return this.db.withTenant(tenantId, (c) => this.createWithClient(c, tenantId, input, actorId));
  }

  list(tenantId: string): Promise<UserView[]> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<UserRow>(`${SELECT_USER} ORDER BY u.created_at, u.email`);
      return rows.map(toView);
    });
  }

  setRoles(tenantId: string, userId: string, roles: Role[], actorId: string): Promise<UserView> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<UserRow>(`${SELECT_USER} WHERE u.id = $1 FOR UPDATE OF u`, [userId]);
      const before = rows[0];
      if (!before) throw new NotFoundException('Utilisateur introuvable');
      if (userId === actorId && !roles.includes('directeur')) {
        throw new BadRequestException('Vous ne pouvez pas retirer votre propre rôle de directeur');
      }
      await c.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
      for (const role of roles) await c.query('INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)', [userId, role]);
      await this.audit.record(
        { tenantId, userId: actorId, action: 'user.roles_changed', objectType: 'user', objectId: userId, before: { roles: before.roles }, after: { roles } },
        c,
      );
      return { ...toView(before), roles };
    });
  }

  setActive(tenantId: string, userId: string, active: boolean, actorId: string): Promise<UserView> {
    return this.db.withTenant(tenantId, async (c) => {
      if (userId === actorId && !active) throw new BadRequestException('Vous ne pouvez pas désactiver votre propre compte');
      const upd = await c.query('UPDATE users SET active = $2 WHERE id = $1', [userId, active]);
      if (upd.rowCount === 0) throw new NotFoundException('Utilisateur introuvable');
      if (!active) await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await this.audit.record(
        { tenantId, userId: actorId, action: active ? 'user.activated' : 'user.deactivated', objectType: 'user', objectId: userId },
        c,
      );
      const { rows } = await c.query<UserRow>(`${SELECT_USER} WHERE u.id = $1`, [userId]);
      return toView(rows[0]!);
    });
  }

  /** Réinitialisation par l'administrateur : nouveau mot de passe, déverrouillage, sessions ouvertes fermées. Le mot de passe n'est jamais journalisé. */
  async setPassword(tenantId: string, userId: string, password: string, actorId: string): Promise<void> {
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    await this.db.withTenant(tenantId, async (c) => {
      const upd = await c.query('UPDATE users SET password_hash = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1', [userId, hash]);
      if (upd.rowCount === 0) throw new NotFoundException('Utilisateur introuvable');
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await this.audit.record({ tenantId, userId: actorId, action: 'user.password_reset', objectType: 'user', objectId: userId }, c);
    });
  }

  /** Création idempotente du premier compte plateforme (commande de démarrage). */
  async ensureSuperAdmin(email: string, password: string): Promise<boolean> {
    return this.db.withPlatform(async (c) => {
      const exists = await c.query('SELECT 1 FROM users WHERE email = $1', [email.toLowerCase()]);
      if (exists.rowCount) return false;
      await this.createWithClient(c, null, { email: email.toLowerCase(), fullName: 'Super-administrateur', password, roles: ['super_admin'] }, null);
      return true;
    });
  }
}
