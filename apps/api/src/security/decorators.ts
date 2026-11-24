import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Permission, Role } from '@transport/shared';

export const IS_PUBLIC = 'route:public';
export const IS_AUTHENTICATED_ONLY = 'route:authenticated-only';
export const REQUIRED_PERMISSIONS = 'route:permissions';

/** Route sans authentification (connexion, santé). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route pour tout utilisateur connecté, sans permission particulière (profil, déconnexion). */
export const AuthenticatedOnly = () => SetMetadata(IS_AUTHENTICATED_ONLY, true);
/** Permissions exigées (toutes). Une route sans aucune de ces trois déclarations est refusée (403). */
export const RequirePermissions = (...permissions: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, permissions);

export interface AuthUser {
  id: string;
  tenantId: string | null;
  roles: Role[];
  permissions: Permission[];
}
export interface ReqLike {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
}
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<ReqLike>().user as AuthUser;
});
