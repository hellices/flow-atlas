import { Body, Controller, Get, Param, Post } from '@nestjs/common';

@Controller('orders')
export class OrdersController {
  @Get()
  public getOrders() {
    return [];
  }

  @Get(':id')
  public getOrder(@Param('id') id: string) {
    return { id };
  }

  @Post()
  public createOrder(@Body() data: unknown) {
    return data;
  }
}
