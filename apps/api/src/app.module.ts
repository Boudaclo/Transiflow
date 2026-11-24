import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { SecurityModule } from './security/security.module';
import { AuditModule } from './modules/audit';
import { AuthModule } from './modules/auth';
import { BilletterieModule } from './modules/billetterie';
import { ClientsModule } from './modules/clients';
import { FinanceModule } from './modules/finance';
import { FlotteModule } from './modules/flotte';
import { LignesModule } from './modules/lignes';
import { PersonnelModule } from './modules/personnel';
import { ReportingModule } from './modules/reporting';
import { TenantsModule } from './modules/tenants';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    SecurityModule,
    AuditModule,
    AuthModule,
    TenantsModule,
    ClientsModule,
    LignesModule,
    BilletterieModule,
    FlotteModule,
    PersonnelModule,
    FinanceModule,
    ReportingModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
