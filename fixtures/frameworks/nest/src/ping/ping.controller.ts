import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';

@Controller({ path: 'ping', version: VERSION_NEUTRAL })
export class PingController {
  @Get()
  ping(): string {
    return 'pong';
  }
}
