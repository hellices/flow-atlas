# OpenAPI documents from the framework

atlas parses TypeScript and JavaScript routes (Nest, Express-style receivers) and FastAPI decorators. For every other
server framework, and to see routes the code composes in ways atlas cannot follow, give atlas the OpenAPI document the
framework itself generates. Generating it means running the application's code, so it is your job (or CI's), not
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
  `read` → `read(`), evidence `name`; else, when no name or several match, exactly one place in the component's
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
| Spring Boot + springdoc-openapi | OpenAPI 3.1 (3.0 by setting) | a `@SpringBootTest` with `MockMvc` that GETs `/v3/api-docs` and writes the body; set `springdoc.writer-with-default-pretty-printer=true` so `described` lines mean something |

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
