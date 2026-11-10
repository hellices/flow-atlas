import { Controller, Get } from '@nestjs/common';

@Controller()
export class AdminController {
  @Get()
  index(): string {
    return 'Admin page';
  }
}
