import { Controller, Get, Version } from '@nestjs/common';

@Controller('portfolio')
export class PortfolioController {
  /** @deprecated */
  @Get('performance')
  public getPerformance() {
    return {};
  }

  @Get('performance')
  @Version('2')
  public getPerformanceV2() {
    return {};
  }
}
