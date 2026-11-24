import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query } from '@nestjs/common';
import { HandleAnomalyInput, ListAnomaliesQuery, handleAnomalySchema, listAnomaliesQuery } from '@transport/shared';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthUser, CurrentUser, RequirePermissions } from '../../security/decorators';
import { AnomaliesService } from './anomalies.service';

@Controller('anomalies')
export class AnomaliesController {
  constructor(private readonly anomalies: AnomaliesService) {}

  @RequirePermissions('administration:administrer')
  @Get()
  list(@CurrentUser() me: AuthUser, @Query(new ZodValidationPipe(listAnomaliesQuery)) q: ListAnomaliesQuery) {
    return this.anomalies.list(me.tenantId!, q);
  }

  @RequirePermissions('administration:administrer')
  @Get('resume')
  summary(@CurrentUser() me: AuthUser) {
    return this.anomalies.summary(me.tenantId!);
  }

  @RequirePermissions('administration:administrer')
  @Patch(':id')
  handle(@CurrentUser() me: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(handleAnomalySchema)) body: HandleAnomalyInput) {
    return this.anomalies.handle(me.tenantId!, me.id, id, body.note);
  }
}
