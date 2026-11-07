import { RequestMethod, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app/app.module';
import { BULL_BOARD_ROUTE, SUPPORTED_LANGUAGE_CODES } from './app/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableVersioning({
    defaultVersion: '1',
    type: VersioningType.URI
  });
  app.setGlobalPrefix('api', {
    exclude: [
      `${BULL_BOARD_ROUTE.substring(1)}{/*wildcard}`,
      '.well-known{/*wildcard}',
      'sitemap.xml',
      { path: 'health', method: RequestMethod.GET },
      ...SUPPORTED_LANGUAGE_CODES.map((languageCode) => {
        return `/${languageCode}{/*wildcard}`;
      })
    ]
  });

  await app.listen(3333);
}

bootstrap();
