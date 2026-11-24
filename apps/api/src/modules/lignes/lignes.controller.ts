import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import {
  AddStopInput, CreateLineInput, RenameStopInput, SetActiveInput, UpdateLineInput, UpsertFareInput,
  addStopSchema, createLineSchema, renameStopSchema, setActiveSchema, updateLineSchema, upsertFareSchema,
} from '@transport/shared';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthUser, CurrentUser, RequirePermissions } from '../../security/decorators';
import { LignesService } from './lignes.service';

const uuid = () => new ParseUUIDPipe();

@Controller('lignes')
export class LignesController {
  constructor(private readonly lignes: LignesService) {}

  @RequirePermissions('lignes:lire')
  @Get()
  list(@CurrentUser() me: AuthUser) {
    return this.lignes.list(me.tenantId!);
  }

  @RequirePermissions('lignes:lire')
  @Get(':id')
  get(@CurrentUser() me: AuthUser, @Param('id', uuid()) id: string) {
    return this.lignes.get(me.tenantId!, id);
  }

  @RequirePermissions('lignes:ecrire')
  @Post()
  create(@CurrentUser() me: AuthUser, @Body(new ZodValidationPipe(createLineSchema)) body: CreateLineInput) {
    return this.lignes.create(me.tenantId!, body, me.id);
  }

  @RequirePermissions('lignes:ecrire')
  @Patch(':id')
  update(@CurrentUser() me: AuthUser, @Param('id', uuid()) id: string, @Body(new ZodValidationPipe(updateLineSchema)) body: UpdateLineInput) {
    return this.lignes.update(me.tenantId!, id, body, me.id);
  }

  @RequirePermissions('lignes:ecrire')
  @Post(':id/arrets')
  addStop(@CurrentUser() me: AuthUser, @Param('id', uuid()) id: string, @Body(new ZodValidationPipe(addStopSchema)) body: AddStopInput) {
    return this.lignes.addStop(me.tenantId!, id, body, me.id);
  }

  @RequirePermissions('lignes:ecrire')
  @Patch(':id/arrets/:stopId')
  renameStop(@CurrentUser() me: AuthUser, @Param('id', uuid()) id: string, @Param('stopId', uuid()) stopId: string, @Body(new ZodValidationPipe(renameStopSchema)) body: RenameStopInput) {
    return this.lignes.renameStop(me.tenantId!, id, stopId, body.name, me.id);
  }

  @RequirePermissions('lignes:ecrire')
  @Delete(':id/arrets/:stopId')
  @HttpCode(200)
  removeStop(@CurrentUser() me: AuthUser, @Param('id', uuid()) id: string, @Param('stopId', uuid()) stopId: string) {
    return this.lignes.removeStop(me.tenantId!, id, stopId, me.id);
  }

  @RequirePermissions('lignes:ecrire')
  @Put(':id/tarifs')
  upsertFare(@CurrentUser() me: AuthUser, @Param('id', uuid()) id: string, @Body(new ZodValidationPipe(upsertFareSchema)) body: UpsertFareInput) {
    return this.lignes.upsertFare(me.tenantId!, id, body, me.id);
  }

  @RequirePermissions('lignes:ecrire')
  @Patch(':id/tarifs/:fareId')
  setFareActive(@CurrentUser() me: AuthUser, @Param('id', uuid()) id: string, @Param('fareId', uuid()) fareId: string, @Body(new ZodValidationPipe(setActiveSchema)) body: SetActiveInput) {
    return this.lignes.setFareActive(me.tenantId!, id, fareId, body.active, me.id);
  }
}
