// Makes every request the app's services make once. The services are compiled by `npm run build` (tsc) and created by
// an environment injector built from the app's own `appConfig` (HttpClient on the Fetch API, with its interceptors),
// as `bootstrapApplication` would, Angular's JIT compiler standing in for the CLI's AOT build. The environment's
// `apiUrl` is pointed at the recording server, its path kept, as a build configuration's `fileReplacements` would.
// Each service method is called with ARG for each argument (ARG_NUMBER where it takes a number) and subscribed to.
import "@angular/compiler";
import { createEnvironmentInjector, Injector, provideZonelessChangeDetection, VERSION, ɵINJECTOR_SCOPE } from "@angular/core";
import { createRequire } from "node:module";
import { firstValueFrom } from "rxjs";

const require = createRequire(import.meta.url);
const { environment } = require("./dist/environments/environment.js");
environment.apiUrl = new URL(new URL(environment.apiUrl).pathname, process.env.RECORD_URL).href;

const { appConfig } = require("./dist/app/app.config.js");
const injector = createEnvironmentInjector(
  [...appConfig.providers, provideZonelessChangeDetection(), { provide: ɵINJECTOR_SCOPE, useValue: "root" }],
  Injector.NULL,
);

const services = [
  require("./dist/app/users/user.service.js").UserService,
  require("./dist/app/orders/order.service.js").OrderService,
  require("./dist/app/reports/report.service.js").ReportService,
];
/** The arguments that take a number, by their position. */
const numeric = { "UserService.list": [0], "ReportService.yearly": [0], "ReportService.export": [0] };

for (const type of services) {
  const service = injector.get(type);
  for (const name of Object.getOwnPropertyNames(type.prototype).filter((n) => n !== "constructor")) {
    const method = service[name];
    const args = Array.from({ length: method.length }, (_, i) =>
      numeric[`${type.name}.${name}`]?.includes(i) ? Number(process.env.ARG_NUMBER) : process.env.ARG,
    );
    try {
      await firstValueFrom(method.apply(service, args));
    } catch (error) {
      throw new Error(`${type.name}.${name}: ${error.message}`);
    }
  }
}
injector.destroy();
console.log(JSON.stringify({ library: "@angular/common/http", version: VERSION.full }));
