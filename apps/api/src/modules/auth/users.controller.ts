import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import {
  CreateUserInput, SetActiveInput, SetPasswordInput, setPasswordSchema, SetRolesInput, createUserSchema, setActiveSchema, setRolesSchema,
} from '@transport/shared';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthUser, CurrentUser, RequirePermissions } from '../../security/decorators';
import { UsersService } from './users.service';

// L'identifiant de compagnie vient toujours du jeton, jamais de la requête.
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermissions('administration:administrer')
  @Get()
  list(@CurrentUser() me: AuthUser) {
    return this.users.list(me.tenantId!);
  }

  @RequirePermissions('administration:administrer')
  @Post()
  create(@CurrentUser() me: AuthUser, @Body(new ZodValidationPipe(createUserSchema)) body: CreateUserInput) {
    return this.users.create(me.tenantId!, body, me.id);
  }

  @RequirePermissions('administration:administrer')
  @Put(':id/roles')
  setRoles(
    @CurrentUser() me: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(setRolesSchema)) body: SetRolesInput,
  ) {
    return this.users.setRoles(me.tenantId!, id, body.roles, me.id);
  }

  @RequirePermissions('administration:administrer')
  @Post(':id/mot-de-passe')
  @HttpCode(204)
  async setPassword(
    @CurrentUser() me: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(setPasswordSchema)) body: SetPasswordInput,
  ): Promise<void> {
    await this.users.setPassword(me.tenantId!, id, body.password, me.id);
  }

  @RequirePermissions('administration:administrer')
  @Patch(':id')
  setActive(
    @CurrentUser() me: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(setActiveSchema)) body: SetActiveInput,
  ) {
    return this.users.setActive(me.tenantId!, id, body.active, me.id);
  }
}
