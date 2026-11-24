import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuditModule],
  controllers: [AuthController, UsersController],
  providers: [AuthService, UsersService],
  exports: [UsersService],
})
export class AuthModule {}
