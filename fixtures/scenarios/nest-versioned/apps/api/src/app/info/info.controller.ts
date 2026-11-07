import { Controller, Get } from '@nestjs/common';

@Controller('info')
export class InfoController {
  @Get()
  public getInfo() {
    return {};
  }
}
