import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Permission, Role, isRole, permissionsFor } from '@transport/shared';
import { AuthUser, IS_AUTHENTICATED_ONLY, IS_PUBLIC, ReqLike, REQUIRED_PERMISSIONS } from './decorators';

export interface TokenPayload {
  sub: string;
  tid: string | null;
  roles: string[];
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<ReqLike>();
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw new UnauthorizedException();
    try {
      const p = await this.jwt.verifyAsync<TokenPayload>(header.slice(7));
      const roles = p.roles.filter(isRole) as Role[];
      const user: AuthUser = { id: p.sub, tenantId: p.tid ?? null, roles, permissions: permissionsFor(roles) };
      req.user = user;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_AUTHENTICATED_ONLY, targets)) return true;
    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, targets);
    const user = ctx.switchToHttp().getRequest<ReqLike>().user;
    // Refus par défaut : une route sans déclaration de permission n'est jamais accessible.
    if (!required || required.length === 0 || !user) throw new ForbiddenException();
    if (!required.every((p) => user.permissions.includes(p))) throw new ForbiddenException();
    return true;
  }
}
