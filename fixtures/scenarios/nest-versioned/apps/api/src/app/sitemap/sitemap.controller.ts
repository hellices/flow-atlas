import { Controller, Get, VERSION_NEUTRAL, Version } from '@nestjs/common';

@Controller('sitemap.xml')
export class SitemapController {
  @Get()
  @Version(VERSION_NEUTRAL)
  public getSitemapXml() {
    return '';
  }
}
