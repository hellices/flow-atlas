import { Controller, Get, Param, Post } from "@nestjs/common";
import { ApiOperation } from "@nestjs/swagger";

@Controller("orders")
export class OrdersController {
  @Get(":id")
  get(@Param("id") id: string) {
    return { id, receipt: "receipt" };
  }

  @Post()
  @ApiOperation({ operationId: "createOrder" })
  create() {
    return { coupon: "coupon" };
  }

  @Get(":id/history")
  history() {
    return [];
  }
}
