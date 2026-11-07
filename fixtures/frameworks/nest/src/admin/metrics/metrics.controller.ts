import { Controller, Get, Version } from '@nestjs/common';

@Controller()
export class MetricsController {
  @Get()
  summary() {
    return { requests: 0 };
  }

  @Version('3')
  @Get('cpu')
  cpu() {
    return { load: 0 };
  }
}
