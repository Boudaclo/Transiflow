import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ReferentielQuery, SyncValidationsInput, ValidateTicketInput, referentielQuery, syncValidationsSchema, validateTicketSchema } from '@transport/shared';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthUser, CurrentUser, RequirePermissions } from '../../security/decorators';
import { ControleService } from './controle.service';
import { ReferenceService } from './reference.service';
import { SyncService } from './sync.service';

@Controller('controle')
export class ControleController {
  constructor(
    private readonly controle: ControleService,
    private readonly sync: SyncService,
    private readonly reference: ReferenceService,
  ) {}

  /** Toujours 200 : le résultat métier (valide, déjà validé, annulé…) est dans le corps. */
  @RequirePermissions('controle:valider')
  @Post('validations')
  @HttpCode(200)
  validate(@CurrentUser() me: AuthUser, @Body(new ZodValidationPipe(validateTicketSchema)) body: ValidateTicketInput) {
    return this.controle.validate(me.tenantId!, me.id, body);
  }

  @RequirePermissions('controle:lire')
  @Get('departs/:id')
  manifest(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.controle.manifest(me.tenantId!, id);
  }

  @RequirePermissions('controle:lire')
  @Get('cles')
  keys(@CurrentUser() me: AuthUser) {
    return this.controle.publicKeys(me.tenantId!);
  }

  /** Clés publiques et billets valides des prochains départs, pour contrôler sans connexion. */
  @RequirePermissions('controle:lire')
  @Get('referentiel')
  referentiel(@CurrentUser() me: AuthUser, @Query(new ZodValidationPipe(referentielQuery)) q: ReferentielQuery) {
    return this.reference.controlData(me.tenantId!, q);
  }

  /** Reçoit les validations faites hors ligne. Rejouable sans doublon. */
  @RequirePermissions('controle:valider')
  @Post('synchronisation')
  @HttpCode(200)
  syncValidations(@CurrentUser() me: AuthUser, @Body(new ZodValidationPipe(syncValidationsSchema)) body: SyncValidationsInput) {
    return this.sync.syncValidations(me.tenantId!, me.id, body);
  }
}
