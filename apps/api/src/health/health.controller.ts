import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@transport/shared';
import { Public } from '../security/decorators';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check(): HealthResponse {
    return { status: 'ok', service: 'transport-saas-api', time: new Date().toISOString() };
  }
}
