import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { LoginInput, RefreshInput, loginSchema, refreshSchema } from '@transport/shared';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthUser, AuthenticatedOnly, CurrentUser, Public, ReqLike } from '../../security/decorators';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodValidationPipe(loginSchema)) body: LoginInput, @Req() req: ReqLike) {
    return this.auth.login(body.email, body.password, req.ip);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput) {
    return this.auth.refresh(body.refreshToken);
  }

  @AuthenticatedOnly()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput): Promise<void> {
    await this.auth.logout(user, body.refreshToken);
  }

  @AuthenticatedOnly()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }
}
