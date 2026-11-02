import "reflect-metadata";
import { Body, Controller, Get, Module, Param, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { ApiExcludeEndpoint, ApiOperation, DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

@Controller("orders")
class OrdersController {
  @Get(":id")
  read(@Param("id") id: string) {
    return { id };
  }

  @Post()
  create(@Body() body: unknown) {
    return body;
  }

  @Get(":id/history")
  @ApiOperation({ operationId: "orderHistory" })
  history(@Param("id") id: string) {
    return [id];
  }

  @Get("internal/health")
  @ApiExcludeEndpoint()
  health() {
    return {};
  }
}

@Module({ controllers: [OrdersController] })
class AppModule {}

async function main() {
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), { logger: false });
  app.setGlobalPrefix("api/v1");
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("Orders").setVersion("1").build());
  process.stdout.write(JSON.stringify(document, null, 2));
  await app.close();
}

main();
