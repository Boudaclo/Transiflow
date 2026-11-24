import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  CreateTripInput, ListTripsQuery, UpdateTripInput, createTripSchema, listTripsQuery, updateTripSchema,
} from '@transport/shared';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthUser, CurrentUser, RequirePermissions } from '../../security/decorators';
import { TripsService } from './trips.service';

@Controller('departs')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @RequirePermissions('lignes:lire')
  @Get()
  list(@CurrentUser() me: AuthUser, @Query(new ZodValidationPipe(listTripsQuery)) q: ListTripsQuery) {
    return this.trips.list(me.tenantId!, q);
  }

  @RequirePermissions('lignes:lire')
  @Get(':id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.get(me.tenantId!, id);
  }

  @RequirePermissions('lignes:ecrire')
  @Post()
  create(@CurrentUser() me: AuthUser, @Body(new ZodValidationPipe(createTripSchema)) body: CreateTripInput) {
    return this.trips.create(me.tenantId!, body, me.id);
  }

  @RequirePermissions('lignes:ecrire')
  @Patch(':id')
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(updateTripSchema)) body: UpdateTripInput) {
    return this.trips.update(me.tenantId!, id, body, me.id);
  }
}
