import { Module } from '@nestjs/common';
import { BilletterieModule } from '../billetterie';
import { LignesModule } from '../lignes';
import { ReportingController } from './reporting.controller';
import { ReportingService } from './reporting.service';

@Module({
  imports: [BilletterieModule, LignesModule],
  controllers: [ReportingController],
  providers: [ReportingService],
  exports: [ReportingService],
})
export class ReportingModule {}
