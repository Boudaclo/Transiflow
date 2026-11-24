import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import {
  CancelTicketInput, ListTicketsQuery, ListTripsQuery, ReferentielQuery, SellTicketInput, SyncSalesInput,
  cancelTicketSchema, listTicketsQuery, listTripsQuery, referentielQuery, sellTicketSchema, syncSalesSchema,
} from '@transport/shared';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthUser, CurrentUser, RequirePermissions } from '../../security/decorators';
import { BilletterieService } from './billetterie.service';
import { ReferenceService } from './reference.service';
import { SyncService } from './sync.service';

@Controller('billetterie')
export class BilletterieController {
  constructor(
    private readonly billetterie: BilletterieService,
    private readonly sync: SyncService,
    private readonly reference: ReferenceService,
  ) {}

  /** 201 : billet créé. 200 : même vente rejouée, billet déjà existant renvoyé. */
  @RequirePermissions('billetterie:vendre')
  @Post('ventes')
  async sell(
    @CurrentUser() me: AuthUser,
    @Body(new ZodValidationPipe(sellTicketSchema)) body: SellTicketInput,
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ) {
    const { ticket, created } = await this.billetterie.sell(me.tenantId!, me.id, body);
    res.status(created ? 201 : 200);
    return ticket;
  }

  @RequirePermissions('billetterie:lire')
  @Get('departs')
  departs(@CurrentUser() me: AuthUser, @Query(new ZodValidationPipe(listTripsQuery)) q: ListTripsQuery) {
    return this.billetterie.availability(me.tenantId!, q);
  }

  @RequirePermissions('billetterie:lire')
  @Get('tickets')
  list(@CurrentUser() me: AuthUser, @Query(new ZodValidationPipe(listTicketsQuery)) q: ListTicketsQuery) {
    return this.billetterie.list(me.tenantId!, q);
  }

  @RequirePermissions('billetterie:lire')
  @Get('tickets/:id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.billetterie.get(me.tenantId!, id);
  }

  @RequirePermissions('billetterie:annuler')
  @Post('tickets/:id/annulation')
  @HttpCode(200)
  cancel(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(cancelTicketSchema)) body: CancelTicketInput) {
    return this.billetterie.cancel(me.tenantId!, me.id, id, body.reason);
  }

  /** Données de référence pour travailler hors ligne (lignes, tarifs, départs). */
  @RequirePermissions('billetterie:lire')
  @Get('referentiel')
  referentiel(@CurrentUser() me: AuthUser, @Query(new ZodValidationPipe(referentielQuery)) q: ReferentielQuery) {
    return this.reference.catalog(me.tenantId!, q);
  }

  /** Reçoit les ventes faites hors ligne par un poste de vente. Rejouable sans doublon. */
  @RequirePermissions('billetterie:vendre')
  @Post('synchronisation')
  @HttpCode(200)
  syncSales(@CurrentUser() me: AuthUser, @Body(new ZodValidationPipe(syncSalesSchema)) body: SyncSalesInput) {
    return this.sync.syncSales(me.tenantId!, me.id, body);
  }

  /** Confirme un paiement mobile saisi hors ligne. */
  @RequirePermissions('administration:administrer')
  @Post('tickets/:id/paiement-verifie')
  @HttpCode(200)
  verifyPayment(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.billetterie.verifyPayment(me.tenantId!, me.id, id);
  }
}
