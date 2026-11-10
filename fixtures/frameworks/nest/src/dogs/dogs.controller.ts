import { Controller, Get, Param, Version, VERSION_NEUTRAL } from '@nestjs/common';

@Controller({ path: 'dogs', version: ['1', '2'] })
export class DogsController {
  @Get()
  findAll(): string {
    return 'This action returns all dogs for version 1 or 2';
  }

  @Version(VERSION_NEUTRAL)
  @Get('count')
  count(): number {
    return 0;
  }

  @Version('3')
  @Get('trips/:from-:to')
  trip(@Param('from') from: string, @Param('to') to: string) {
    return { from, to };
  }
}
