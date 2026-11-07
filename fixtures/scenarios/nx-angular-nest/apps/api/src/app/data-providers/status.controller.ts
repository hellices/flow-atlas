import { Controller, Get } from '@nestjs/common';

@Controller('api/v2/data-providers/remote')
export class StatusController {
  @Get('status')
  public async getStatus() {
    return { status: 'ok' };
  }
}
