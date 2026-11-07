import { Controller, Get, Post } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  index(): string {
    return 'Hello World!';
  }

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Post('health')
  report() {
    return { received: true };
  }

  @Get('about')
  about(): string {
    return 'About';
  }
}
