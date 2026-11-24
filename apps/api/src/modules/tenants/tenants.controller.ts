import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CreateTenantInput, SetActiveInput, createTenantSchema, setActiveSchema } from '@transport/shared';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthUser, CurrentUser, RequirePermissions } from '../../security/decorators';
import { TenantsService } from './tenants.service';

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @RequirePermissions('plateforme:administrer')
  @Post()
  create(@CurrentUser() me: AuthUser, @Body(new ZodValidationPipe(createTenantSchema)) body: CreateTenantInput) {
    return this.tenants.create(body, me.id);
  }

  @RequirePermissions('plateforme:administrer')
  @Get()
  list() {
    return this.tenants.list();
  }

  @RequirePermissions('plateforme:administrer')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.get(id);
  }

  @RequirePermissions('plateforme:administrer')
  @Patch(':id')
  setActive(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(setActiveSchema)) body: SetActiveInput) {
    return this.tenants.setActive(id, body.active, me.id);
  }
}
