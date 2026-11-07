import { All, Body, Controller, Delete, Get, Param, Patch, Post, Put, QueryMethod, Version } from '@nestjs/common';
import type { Cat } from './cats.service.js';
import { CatsService } from './cats.service.js';

@Controller('cats')
export class CatsController {
  constructor(private readonly catsService: CatsService) {}

  @Post()
  create(@Body() cat: Partial<Cat> = {}) {
    return this.catsService.create(cat);
  }

  @Get()
  findAll(): Cat[] {
    return this.catsService.findAll();
  }

  @Version('2')
  @Get()
  findAllV2() {
    return { items: this.catsService.findAll() };
  }

  @QueryMethod('search')
  search(@Body() filter: Partial<Cat> = {}) {
    return this.catsService.findAll().filter((cat) => !filter.name || cat.name === filter.name);
  }

  @Get('abcd/*')
  wildcard(): string {
    return 'This route uses a wildcard';
  }

  @Get('files/*filepath')
  file(@Param('filepath') filepath: string[]) {
    return { path: filepath.join('/') };
  }

  @All('legacy')
  legacy(): string {
    return 'Any method';
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.catsService.findOne(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() cat: Cat) {
    return { ...cat, id };
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body('name') name: string) {
    return { id, name };
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return `This action removes a #${id} cat`;
  }

  @Get(':id/kittens/:kittenId')
  findKitten(@Param('id') id: string, @Param('kittenId') kittenId: string) {
    return { id, kittenId };
  }
}
