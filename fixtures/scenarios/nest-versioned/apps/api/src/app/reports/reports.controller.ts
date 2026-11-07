import { Controller, Get } from '@nestjs/common';

@Controller({ path: 'reports', version: ['1', '2'] })
export class ReportsController {
  @Get()
  public getReports() {
    return [];
  }
}
