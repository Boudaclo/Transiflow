import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  RequestDeviceInput, ReserveRangeInput, RevokeDeviceInput, requestDeviceSchema, reserveRangeSchema, revokeDeviceSchema,
} from '@transport/shared';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthUser, AuthenticatedOnly, CurrentUser, RequirePermissions } from '../../security/decorators';
import { PostesService } from './postes.service';

@Controller('postes')
export class PostesController {
  constructor(private readonly postes: PostesService) {}

  /** Demande faite depuis l'appareil par un utilisateur autorisé à vendre (poste de vente) ou à contrôler (poste de contrôle). */
  @AuthenticatedOnly()
  @Post('demandes')
  @HttpCode(201)
  request(@CurrentUser() me: AuthUser, @Body(new ZodValidationPipe(requestDeviceSchema)) body: RequestDeviceInput) {
    const needed = body.kind === 'vente' ? 'billetterie:vendre' : 'controle:valider';
    if (!me.permissions.includes(needed)) throw new ForbiddenException();
    return this.postes.request(me.tenantId!, me.id, body);
  }

  @RequirePermissions('administration:administrer')
  @Get()
  list(@CurrentUser() me: AuthUser) {
    return this.postes.list(me.tenantId!);
  }

  @RequirePermissions('administration:administrer')
  @Post(':id/activation')
  @HttpCode(200)
  activate(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.postes.activate(me.tenantId!, me.id, id);
  }

  @RequirePermissions('administration:administrer')
  @Post(':id/revocation')
  @HttpCode(200)
  revoke(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(revokeDeviceSchema)) body: RevokeDeviceInput) {
    return this.postes.revoke(me.tenantId!, me.id, id, body.reason);
  }

  @AuthenticatedOnly()
  @Get(':id/etat')
  state(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.postes.state(me.tenantId!, id);
  }

  @RequirePermissions('billetterie:vendre')
  @Post(':id/plages')
  @HttpCode(201)
  reserve(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(reserveRangeSchema)) body: ReserveRangeInput) {
    return this.postes.reserveRange(me.tenantId!, id, body.size);
  }
}
