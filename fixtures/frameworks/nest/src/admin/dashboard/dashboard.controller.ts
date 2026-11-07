import { Controller, Delete, Get, Param } from '@nestjs/common';

@Controller('widgets')
export class DashboardController {
  @Get()
  findAll(): string[] {
    return [];
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return { id };
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return { id, removed: true };
  }
}
