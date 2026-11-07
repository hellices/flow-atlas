import { Controller, Get, Param, VERSION_NEUTRAL } from '@nestjs/common';

@Controller({ path: 'assets', version: VERSION_NEUTRAL })
export class AssetsController {
  @Get(':languageCode/site.webmanifest')
  public getWebManifest(@Param('languageCode') languageCode: string) {
    return { languageCode };
  }
}
