import { Controller, Get, Query } from '@nestjs/common';
import { ListAuditQuery, listAuditQuery } from '@transport/shared';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthUser, CurrentUser, RequirePermissions } from '../../security/decorators';
import { AuditService } from './audit.service';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @RequirePermissions('administration:administrer')
  @Get()
  list(@CurrentUser() me: AuthUser, @Query(new ZodValidationPipe(listAuditQuery)) q: ListAuditQuery) {
    return this.audit.list(me.tenantId!, q);
  }
}
