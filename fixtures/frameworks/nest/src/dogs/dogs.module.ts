import { Module } from '@nestjs/common';
import { DogsController } from './dogs.controller.js';

@Module({
  controllers: [DogsController],
})
export class DogsModule {}
