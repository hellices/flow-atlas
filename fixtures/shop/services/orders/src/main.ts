import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

export async function start(module: unknown) {
  const app = await NestFactory.create(module);
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
  SwaggerModule.setup("docs", app, document);
  await app.listen(3001);
}
