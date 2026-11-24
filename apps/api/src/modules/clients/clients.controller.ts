import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  CreateClientInput, ListClientsQuery, UpdateClientInput, createClientSchema, listClientsQuery, updateClientSchema,
} from '@transport/shared';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthUser, CurrentUser, RequirePermissions } from '../../security/decorators';
import { ClientsService } from './clients.service';

@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @RequirePermissions('clients:lire')
  @Get()
  list(@CurrentUser() me: AuthUser, @Query(new ZodValidationPipe(listClientsQuery)) q: ListClientsQuery) {
    return this.clients.list(me.tenantId!, q);
  }

  @RequirePermissions('clients:lire')
  @Get(':id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.clients.get(me.tenantId!, id);
  }

  @RequirePermissions('clients:ecrire')
  @Post()
  create(@CurrentUser() me: AuthUser, @Body(new ZodValidationPipe(createClientSchema)) body: CreateClientInput) {
    return this.clients.create(me.tenantId!, body);
  }

  @RequirePermissions('clients:ecrire')
  @Patch(':id')
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(updateClientSchema)) body: UpdateClientInput) {
    return this.clients.update(me.tenantId!, id, body);
  }
}
