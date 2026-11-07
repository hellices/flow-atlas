import { Controller, Get, VERSION_NEUTRAL, Version } from '@nestjs/common';

@Controller('.well-known')
export class WellKnownController {
  @Get('oauth-authorization-server')
  @Version(VERSION_NEUTRAL)
  public getAuthorizationServerMetadata() {
    return {};
  }
}
