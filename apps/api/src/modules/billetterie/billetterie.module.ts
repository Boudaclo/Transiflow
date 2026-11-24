import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { ClientsModule } from '../clients';
import { LignesModule } from '../lignes';
import { AnomaliesController } from './anomalies.controller';
import { AnomaliesService } from './anomalies.service';
import { BilletterieController } from './billetterie.controller';
import { BilletterieService } from './billetterie.service';
import { ControleController } from './controle.controller';
import { ControleService } from './controle.service';
import { PostesController } from './postes.controller';
import { PostesService } from './postes.service';
import { ReferenceService } from './reference.service';
import { SalesStatsService } from './sales-stats.service';
import { SigningKeysService } from './signing-keys.service';
import { SyncService } from './sync.service';

@Module({
  imports: [AuditModule, ClientsModule, LignesModule],
  controllers: [BilletterieController, ControleController, PostesController, AnomaliesController],
  providers: [BilletterieService, ControleService, SigningKeysService, PostesService, AnomaliesService, SyncService, ReferenceService, SalesStatsService],
  exports: [BilletterieService, ControleService, SigningKeysService, PostesService, SalesStatsService],
})
export class BilletterieModule {}
