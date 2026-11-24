import { HttpException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { PoolClient } from 'pg';
import { Permission, Role, isRole, permissionsFor } from '@transport/shared';
import { AppConfig, CONFIG } from '../../config';
import { DbService } from '../../database/db.service';
import { AuditService } from '../audit';

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LoginRow {
  id: string; tenant_id: string | null; email: string; full_name: string; password_hash: string; active: boolean;
  failed_attempts: number; locked_until: Date | null; tenant_active: boolean; roles: string[];
}
interface TokenRow {
  id: string; family_id: string; user_id: string; tenant_id: string | null; token_hash: string;
  expires_at: Date; used_at: Date | null; revoked_at: Date | null;
}
export interface SessionUser {
  id: string; email: string; fullName: string; tenantId: string | null; roles: Role[]; permissions: Permission[];
}
export interface Session {
  accessToken: string; refreshToken: string; expiresIn: number; user: SessionUser;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const invalidCredentials = () => new UnauthorizedException('Identifiants invalides');
const invalidToken = () => new UnauthorizedException('Session invalide ou expirée');

@Injectable()
export class AuthService {
  // Hash factice : un e-mail inconnu coûte le même temps de calcul qu'un mot de passe erroné.
  private readonly dummyHash = argon2.hash('mot-de-passe-factice', { type: argon2.argon2id });

  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  async login(email: string, password: string, ip?: string): Promise<Session> {
    const rows = await this.db.queryDirect<LoginRow>('SELECT * FROM auth_find_user_by_email($1)', [email]);
    const u = rows[0];
    const valid = await argon2.verify(u?.password_hash ?? (await this.dummyHash), password).catch(() => false);

    if (!u) {
      await this.audit.record({ tenantId: null, userId: null, action: 'auth.login_failed', after: { email, reason: 'unknown' }, ip });
      throw invalidCredentials();
    }
    if (u.locked_until && u.locked_until > new Date()) {
      await this.audit.record({ tenantId: u.tenant_id, userId: u.id, action: 'auth.login_locked', ip });
      throw new HttpException('Compte temporairement verrouillé. Réessayez plus tard.', 423);
    }
    if (!valid || !u.active || !u.tenant_active) {
      await this.db.scope(u.tenant_id, async (c) => {
        if (!valid) {
          await c.query(
            `UPDATE users SET
               locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
               failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END
             WHERE id = $1`,
            [u.id, MAX_ATTEMPTS, LOCK_MINUTES],
          );
        }
        await this.audit.record(
          { tenantId: u.tenant_id, userId: u.id, action: 'auth.login_failed', after: { reason: valid ? 'inactive' : 'bad_password' }, ip },
          c,
        );
      });
      throw invalidCredentials();
    }

    const roles = u.roles.filter(isRole) as Role[];
    return this.db.scope(u.tenant_id, async (c) => {
      await c.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [u.id]);
      const tokens = await this.issue(c, { id: u.id, tenantId: u.tenant_id, roles }, randomUUID());
      await this.audit.record({ tenantId: u.tenant_id, userId: u.id, action: 'auth.login', ip }, c);
      return { ...tokens, user: { id: u.id, email: u.email, fullName: u.full_name, tenantId: u.tenant_id, roles, permissions: permissionsFor(roles) } };
    });
  }

  async refresh(token: string): Promise<Session> {
    const [id, secret] = token.split('.');
    if (!id || !secret || !UUID_RE.test(id)) throw invalidToken();
    const t = (await this.db.queryDirect<TokenRow>('SELECT * FROM auth_find_refresh_token($1)', [id]))[0];
    if (!t || !sameHash(sha256(secret), t.token_hash) || t.revoked_at) throw invalidToken();

    if (t.used_at) {
      // Réutilisation d'un jeton déjà échangé : vol probable, on révoque toute la famille.
      await this.db.scope(t.tenant_id, async (c) => {
        await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [t.family_id]);
        await this.audit.record({ tenantId: t.tenant_id, userId: t.user_id, action: 'auth.refresh_reuse_detected' }, c);
      });
      throw invalidToken();
    }
    if (t.expires_at < new Date()) throw invalidToken();

    return this.db.scope(t.tenant_id, async (c) => {
      const { rows } = await c.query<LoginRow>(
        `SELECT u.id, u.tenant_id, u.email, u.full_name, u.password_hash, u.active, u.failed_attempts, u.locked_until,
                coalesce((SELECT active FROM tenants WHERE id = u.tenant_id), true) AS tenant_active,
                array(SELECT ur.role_code FROM user_roles ur WHERE ur.user_id = u.id ORDER BY ur.role_code) AS roles
         FROM users u WHERE u.id = $1`,
        [t.user_id],
      );
      const u = rows[0];
      if (!u || !u.active || !u.tenant_active) throw invalidToken();
      const used = await c.query('UPDATE refresh_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL', [t.id]);
      if (used.rowCount === 0) throw invalidToken();
      const roles = u.roles.filter(isRole) as Role[];
      const tokens = await this.issue(c, { id: u.id, tenantId: u.tenant_id, roles }, t.family_id);
      return { ...tokens, user: { id: u.id, email: u.email, fullName: u.full_name, tenantId: u.tenant_id, roles, permissions: permissionsFor(roles) } };
    });
  }

  async logout(user: { id: string; tenantId: string | null }, token: string): Promise<void> {
    const id = token.split('.')[0];
    if (!id || !UUID_RE.test(id)) return;
    await this.db.scope(user.tenantId, async (c) => {
      await c.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE revoked_at IS NULL AND family_id = (SELECT family_id FROM refresh_tokens WHERE id = $1 AND user_id = $2)`,
        [id, user.id],
      );
      await this.audit.record({ tenantId: user.tenantId, userId: user.id, action: 'auth.logout' }, c);
    });
  }

  async me(user: { id: string; tenantId: string | null }): Promise<SessionUser> {
    return this.db.scope(user.tenantId, async (c) => {
      const { rows } = await c.query<LoginRow>(
        `SELECT u.id, u.tenant_id, u.email, u.full_name,
                array(SELECT ur.role_code FROM user_roles ur WHERE ur.user_id = u.id ORDER BY ur.role_code) AS roles
         FROM users u WHERE u.id = $1`,
        [user.id],
      );
      const u = rows[0];
      if (!u) throw new UnauthorizedException();
      const roles = u.roles.filter(isRole) as Role[];
      return { id: u.id, email: u.email, fullName: u.full_name, tenantId: u.tenant_id, roles, permissions: permissionsFor(roles) };
    });
  }

  private async issue(c: PoolClient, u: { id: string; tenantId: string | null; roles: Role[] }, familyId: string) {
    const tokenId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    await c.query(
      `INSERT INTO refresh_tokens (id, family_id, user_id, tenant_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6::int))`,
      [tokenId, familyId, u.id, u.tenantId, sha256(secret), this.cfg.refreshTtlDays],
    );
    const accessToken = await this.jwt.signAsync({ sub: u.id, tid: u.tenantId, roles: u.roles });
    return { accessToken, refreshToken: `${tokenId}.${secret}`, expiresIn: this.cfg.accessTtlSeconds };
  }
}
