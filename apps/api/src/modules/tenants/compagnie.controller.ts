import { Body, Controller, Get, Patch } from '@nestjs/common';
import { UpdateCompanyInput, updateCompanySchema } from '@transport/shared';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthUser, AuthenticatedOnly, CurrentUser, RequirePermissions } from '../../security/decorators';
import { TenantsService } from './tenants.service';

/** Paramètres de SA compagnie (identifiant tiré du jeton). Lecture pour tout utilisateur connecté, modification pour l'administration. */
@Controller('compagnie')
export class CompagnieController {
  constructor(private readonly tenants: TenantsService) {}

  @AuthenticatedOnly()
  @Get()
  get(@CurrentUser() me: AuthUser) {
    return this.tenants.getOwn(me.tenantId!);
  }

  @RequirePermissions('administration:administrer')
  @Patch()
  update(@CurrentUser() me: AuthUser, @Body(new ZodValidationPipe(updateCompanySchema)) body: UpdateCompanyInput) {
    return this.tenants.updateOwn(me.tenantId!, body, me.id);
  }
}
