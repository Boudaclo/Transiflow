import { Controller, Get, Query, Res } from '@nestjs/common';
import {
  DashboardQuery, ExportQuery, ReportDeparturesQuery, dashboardQuery, exportQuery, reportDeparturesQuery,
} from '@transport/shared';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthUser, CurrentUser, RequirePermissions } from '../../security/decorators';
import { ReportingService } from './reporting.service';

@Controller('tableau-de-bord')
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @RequirePermissions('reporting:lire')
  @Get()
  dashboard(@CurrentUser() me: AuthUser, @Query(new ZodValidationPipe(dashboardQuery)) q: DashboardQuery) {
    return this.reporting.dashboard(me.tenantId!, q);
  }

  @RequirePermissions('reporting:lire')
  @Get('departs')
  departures(@CurrentUser() me: AuthUser, @Query(new ZodValidationPipe(reportDeparturesQuery)) q: ReportDeparturesQuery) {
    return this.reporting.departures(me.tenantId!, q);
  }

  /** Journal des ventes (CSV) pour la comptabilité. */
  @RequirePermissions('reporting:lire')
  @Get('export')
  async export(
    @CurrentUser() me: AuthUser,
    @Query(new ZodValidationPipe(exportQuery)) q: ExportQuery,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): unknown },
  ) {
    const { filename, csv } = await this.reporting.exportCsv(me.tenantId!, q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return csv;
  }
}
