import { Controller, Get } from "@nestjs/common";

@Controller("server")
export class ServerController {
  @Get("ping")
  pingServer() {
    return { res: "pong" };
  }
}
