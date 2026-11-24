import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { LignesController } from './lignes.controller';
import { LignesService } from './lignes.service';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';

@Module({
  imports: [AuditModule],
  controllers: [LignesController, TripsController],
  providers: [LignesService, TripsService],
  exports: [LignesService, TripsService],
})
export class LignesModule {}
