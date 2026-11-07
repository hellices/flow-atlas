import { Controller, Get } from '@nestjs/common';

@Controller('api/v1/info')
export class InfoController {
  @Get()
  public async getInfo() {
    return { version: '1.0.0' };
  }
}
