import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  public getHealth() {
    return { status: 'OK' };
  }

  @Get('jobs')
  public getJobsHealth() {
    return { status: 'OK' };
  }
}
