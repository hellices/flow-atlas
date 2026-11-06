# OpenAPI documents from the framework

atlas parses TypeScript and JavaScript routes (Nest, Express-style receivers), FastAPI decorators and Spring MVC
annotations. For every other server framework, and to see routes the code composes in ways atlas cannot follow, give
atlas the OpenAPI document the framework itself generates. For Spring, use both: `styles: [spring]` gives every Spring
MVC route the annotations spell out (pages included, which springdoc leaves out) at its controller line, and the
document adds springdoc's operationIds, which `export arazzo` needs, and the routes the annotations do not spell out
(a path in a constant, routes registered in code), which only the generated document has. Generating it means running the application's code, so it is your job (or CI's), not
atlas's: atlas only reads files.

```yaml
routes:
  - component: orders
    openapi: services/orders/openapi.json   # in the repository, or an absolute path to a file generated outside it
    files: ["services/orders/src/main/**/*.java"]   # where atlas looks for the handlers; may be empty
```

## What atlas takes from the document

- Every operation becomes a surface: the method, and the path with Swagger 2.0 `basePath` or the path of the first
  OpenAPI 3 server URL in front. A server's scheme and host (variables in them included) and a trailing slash are
  dropped, so `/api/v1/orders/` and a code
  route `/api/v1/orders` are one surface.
- The `operationId`, where the document declares the operation (`described`), and the path key it writes it under
  (`describedPath`), which `export arazzo` uses for an `operationPath`.
- Where the handler is, when the code gives it away: a function named as the framework derives the operationId (FastAPI
  `read_order_api_v1_orders__order_id__get` → `def read_order`, Nest `OrdersController_read` → `read(`, springdoc
  `read` → `read(`; a numbered id such as `read_1`, which springdoc gives the later methods sharing a name, is not
  traced back, since nothing in the document says which generator wrote it), evidence `name`; else, when no name or several match, exactly one place in the component's
  route files that declares the operationId as a quoted value after `operationId` or `operation_id`
  (`operation_id="orderHistory"`, `@Operation(operationId = "orderHistory")`), evidence `text`. If neither finds
  exactly one place, the surface stays at the document, evidence `declared`. A TypeScript or JavaScript handler found
  this way is followed like a code route's (`reaches`), so a trace continues through it.
- When any route entry of the component registers the same route in code (same method and path, whatever the
  parameters are named), the code's location stays and the document adds its operationId and place.
- The document becomes the component's OpenAPI description (`ReadForRoutes`), unless `openapi.<component>` overrides
  it. When several documents describe one operation, the one `openapi.<component>` names gives its operationId and
  place. `export arazzo` resolves each operation against the chosen description when it is a file atlas can read:
  that document's operationId, else its path key; an operation it does not declare is left out with a `limit:`.

It does not take request or response schemas, security, or callers: the document says none of that about the code.

## Documents springdoc serves

For a component whose routes are read with `styles: [spring]`, atlas lists what springdoc-openapi serves for the
Maven or Gradle project the component is part of (the nearest directory at or above its path with a `pom.xml` or
`build.gradle(.kts)`), as served documents; every module of a Spring Modulith application shares them. They are
candidates for the component's description (`references/boundaries.md`), not route sources: give `routes[].openapi`
a generated file for that.

| springdoc.org | What atlas reads |
|---|---|
| "Getting Started": the dependency alone serves the document at `/v3/api-docs` | when the project's own build file puts a `springdoc-openapi` artifact (or a `libs.springdoc.openapi...` catalog entry) on the runtime classpath, or its main code builds a `GroupedOpenApi`, `/v3/api-docs`. Counted: Maven `project/dependencies` in the default, `compile` or `runtime` scope; Gradle `implementation`, `api` or `runtimeOnly` in the project's own `dependencies` block. Not counted: `dependencyManagement`, `test` and `provided` scopes, plugins, `testImplementation`, `compileOnly`, `developmentOnly`, `platform(...)`, `buildscript` and `subprojects`; a Maven profile's dependency is reported |
| core properties: `springdoc.api-docs.path`, `springdoc.api-docs.enabled`, `springdoc.enable-default-api-docs` | the literal path instead; nothing when disabled; only the groups without the default document |
| FAQ 13.48: everything behind `server.servlet.context-path` | a literal base path in front, of the web stack the springdoc starter is for: `server.servlet.context-path` with a WebMvc starter (or 1.x `springdoc-openapi-ui`), `spring.webflux.base-path` with a WebFlux one; the other is ignored. When only code shows springdoc, so the stack is not settled, either one set is reported |
| FAQ 13.1: a `GroupedOpenApi` bean built with `.group("public")` serves `<api-docs path>/public` | one document per bean: a builder in a `@Bean` method of a `@Configuration` (or other component) class in the package of a `@SpringBootApplication` or below. The group is the chain's last `group(...)`, a literal or a string constant of the file that no parameter or local hides |
| FAQ 13.61: `springdoc.group-configs[0].group=users` | the same, per literal group; a list set with more precedence, even `[]`, replaces it, and a repeated key keeps its last value |

Settings come from `src/main/resources/application.properties` and `application.yml` (`.yaml`) and their `config/`
copies, with Spring Boot's precedence (properties over YAML, `config/` over both), YAML aliases and merge keys
resolved and `.properties` escapes (`\u002f`) decoded as Spring Boot loads them; a malformed `\u` escape makes a file
Spring Boot cannot load, so nothing is read from it (and, outside a profile's file, no document is listed). `springdoc.api-docs.enabled` is off
only for `false`, in any case (`off` keeps the endpoints on); `springdoc.enable-default-api-docs` and
`springdoc.use-management-port` mean something only as `true` or `false`, and any other value is reported. Not read, each reported as a
`limit:` in `atlas scan`: a profile's file (`application-dev.yml`) or a YAML document under
`spring.config.activate.on-profile`, since which profile runs is decided at launch; a value with a placeholder
(`${DOCS_PATH:/docs}`), resolved at run time; a group name built in code; a builder outside a `@Bean` method, in a
class that is no component, or outside the packages Spring Boot scans by default (or in a project that sets them); `springdoc.use-management-port`, which moves
the documents to the actuator port. An environment variable such as `SPRINGDOC_API_DOCS_PATH` can still override what
atlas read; that is not visible in the repository. The `.yaml` twin of each document (`/v3/api-docs.yaml`) and the
swagger-ui page are the same documents and are not listed.

## Generating it

Use what the repository already does (a CI step, a `make` target, a committed file) before adding a command. Each
recipe below was run against the framework versions listed in the flow-atlas `fixtures/openapi/README.md`.

| Framework | Document | Without serving it |
|---|---|---|
| FastAPI | OpenAPI 3.1 | `python -c "import json; from app.main import app; print(json.dumps(app.openapi(), indent=2))" > openapi.json` |
| Flask + flask-smorest | OpenAPI 3.x (`OPENAPI_VERSION`) | `json.dumps(api.spec.to_dict(), indent=2)` inside the app context |
| Flask + flasgger | Swagger 2.0 | `app.test_client().get("/apispec_1.json").get_json()`; only routes with a YAML docstring are listed |
| Django REST framework + drf-spectacular | OpenAPI 3.0 | `python manage.py spectacular --format openapi-json --file openapi.json` |
| NestJS + @nestjs/swagger | OpenAPI 3.0 | in a script: `NestFactory.create`, the same global prefix as `main.ts`, `SwaggerModule.createDocument(app, config)`, write it, `app.close()` |
| Fastify + @fastify/swagger | Swagger 2.0 or OpenAPI 3.0 (by `openapi` option) | build the app, `await app.ready()`, write `app.swagger()` |
| Spring Boot (MVC) + springdoc-openapi | OpenAPI 3.1 (3.0 by setting) | a `@SpringBootTest` with `@AutoConfigureMockMvc` whose `MockMvc` GETs each path and group `atlas inventory` lists (`/v3/api-docs` by default) and writes the body; set `springdoc.writer-with-default-pretty-printer=true` so `described` lines mean something |
| Spring Boot (WebFlux) + springdoc-openapi | OpenAPI 3.1 (3.0 by setting) | the same with `@AutoConfigureWebTestClient` and `WebTestClient` (`get().uri(path).exchange().expectBody(String.class)`), since MockMvc does not run a WebFlux application |

Notes:

- Pretty-print the document. A one-line document puts every `described` at line 1.
- A generated `servers` URL comes from the environment that served it (springdoc writes `http://localhost`); atlas
  drops hosts, and so should anything you hand on. Base URLs per environment belong in `origins`.
- Routes a framework hides (`include_in_schema=False`, `@ApiExcludeEndpoint`, `schema.hide`, `@Hidden`) are not in the
  document. If they are called, FA002 will say so; decide with `references/boundaries.md` whether that is a defect.
- An absolute path is read as the file is now, for every revision. For `check --since` and `diff`, commit the document
  or generate it at each revision into the repository; atlas reports a `limit:` otherwise.
- Regenerate it whenever routes change, in the same change. A document older than the code is a stale input, and atlas
  cannot tell.
