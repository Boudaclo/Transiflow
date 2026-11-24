import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { AuthModule } from '../auth';
import { CompagnieController } from './compagnie.controller';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [TenantsController, CompagnieController],
  providers: [TenantsService],
})
export class TenantsModule {}
