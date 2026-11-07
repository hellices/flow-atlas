import { Controller, Get, Post, VERSION_NEUTRAL, Version } from '@nestjs/common';

@Controller('auth')
export class AuthController {
  @Post('anonymous')
  public signInAnonymous() {
    return {};
  }

  @Get('oidc/callback')
  @Version(VERSION_NEUTRAL)
  public oidcCallback() {
    return {};
  }
}
