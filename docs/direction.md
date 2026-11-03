# Direction and scope

Decided November 2026, after applying atlas to a private TypeScript monorepo (mobile app, BFF and services) and to a
server-rendered Spring Boot application, and after surveying prior art. This document records the evidence, the
decision, the scope atlas supports for certain, and the extensions left open.

## Decision

atlas is a deterministic checker of declared flows against an endpoint inventory, with an agent skill that puts the
inventory in front of an agent before it designs a change, and an Arazzo export for viewers and runners. Its own value
is the part no other tool does: holding a declared flow against the code.

What atlas reads, it reads for certain:

- A route or call is read only when its meaning is fixed by a standard or by a framework's documented behavior, and its
  value is written as a literal. Anything else is reported as not read, never guessed.
- Where a framework can describe its own routes (an OpenAPI document, an introspection endpoint), that description is
  preferred to reading the code.
- What static reading cannot see (URLs built at run time, other template engines, client libraries' indirections) is
  left to runtime observation, as an extension, rather than to more parsing.

A guessed call that is wrong is worse than a call not found: it joins the wrong route, hides a real gap and produces
findings nobody acts on.

## Evidence

### Static extraction has a known ceiling

- The one reproducible comparison of static architecture-recovery tools for microservices (Bakhtin et al., 2024)
  found 13 tools, of which 9 ran and 3 produced nothing usable. On 17 Spring applications with hand-built ground
  truth, the best tool reached an overall F1 of 0.86, but only 0.66 on endpoints; the best on endpoints reached 0.79;
  four tools combined reached 0.91 overall. The authors conclude that no single static tool suffices. Those
  applications are backend to backend; templates and browser code, which atlas also reads, are harder.
- The closest open-source tool to atlas's call matching, tieline, reports a URL built at run time as `unverifiable`
  and does not try to resolve it.
- Running atlas's own extractor over 25 patterns common in real templates and scripts gave 9 read correctly, 7 read
  in part or wrongly, and 9 missed. Standard HTML attributes, Thymeleaf link expressions with literal paths, and
  `fetch` with literal or template-string URLs were right. URLs from model variables, other template engines (JSP,
  Jinja, Django, Handlebars), htmx and Vue attributes, and URLs assembled through wrappers or a client's base URL were
  missed or misread. Each fix for the second group is a parser for one more dialect.

### The ecosystem settled each part elsewhere

| Part | Where the ecosystem gets it | Examples |
|---|---|---|
| endpoint inventory | the framework's own description | springdoc, Spring Boot Actuator `/actuator/mappings`, Encore, tRPC |
| call edges | runtime observation | OpenTelemetry service graph, Kiali, Datadog and Azure service maps, Postman Insights, mitmproxy2swagger, HAR to OpenAPI |
| flow verification | execution | Pact, Redocly Respect and the Jentic Arazzo runner for Arazzo |
| flow visualization | standard viewers | Arazzo UI (diagram, sequence, flowchart) |

Two cautions from the same survey: Optic, which inferred and diffed OpenAPI from captured traffic, is archived, and so
is ts-rest. Keeping such tools alive is costly, which argues for a narrow scope.

### The gap atlas fills

- No tool found checks a declared Arazzo workflow, or any declared multi-step flow, against the code. Arazzo tools
  lint the document (Spectral, the Jentic validator) or run it against a server (Respect, the Jentic runner).
- Spec-driven development frameworks for agents (GitHub Spec Kit, OpenSpec, BMAD, Kiro) leave the agreement between
  specification and code to the agent or to the team's process; none has a deterministic check.
- Agents leave documentation behind: in a study of 29,669 agent-authored pull requests, 63% changed code without
  changing its documentation (De Michele and Tantithamthavorn, 2026).

### The pattern is established

- A skill that tells the agent when to run a deterministic tool, with the tool doing the work: Anthropic's own skills,
  Speakeasy's `extract-openapi-from-code`.
- A declared model checked against the code in CI, failing the pull request: Spring Modulith `verify()`, ArchUnit,
  dependency-cruiser.
- Findings must be actionable, nearly free of false positives and shown where developers already work, or they are
  ignored (Sadowski et al., "Lessons from building static analysis tools at Google", CACM 2018).

### What atlas showed in practice

- Replaying 478 commits of the private monorepo, the caller and producer rules fired on 5 pull requests, all real
  problems; 2 stayed unnoticed until a separate manual audit. Structural flow defects are rare (about one in a hundred
  commits), and most defects in the same period were about fields, wiring and runtime state, which atlas does not see.
  The value is in catching the rare structural break when the pull request is open, not in catching most defects.
- In the Spring application, all 9 "no caller" findings were REST endpoints served on purpose to clients outside the
  repository. Declaring them in `publicSurfaces` is the fix; without it the rule would be noise there.

## Scope

| Area | Read for certain | Not read (reported, never guessed) |
|---|---|---|
| routes | OpenAPI 2.0 and 3.x documents; NestJS, Express, Fastify and FastAPI registrations with literal paths; Spring MVC mapping annotations with literal paths in Java and Kotlin, a type's mapping joined to its methods' and the methods united as Spring does; the login and logout POST endpoints of Spring Security's `formLogin` and `logout`, from their defaults and literal setters on the configurer | paths in constants or expressions, Kotlin string templates, functional or programmatic routes, composed annotations, a Security customizer defined elsewhere |
| client calls in code | TypeScript and JavaScript parsed: string literals, template strings and concatenations, a part that is not a literal standing for unknown text; methods stated at the call | paths assembled across functions, a client's base URL or interceptors, Kotlin, Python and other languages beyond strings that look like paths |
| client calls in HTML | start-tag attributes `href`, `src`, `action`, `formaction` with root-relative literal values, methods as the HTML standard defines them; Thymeleaf link expressions with literal paths in `th:*` URL attributes, `th:attr` items and `[[...]]` in JavaScript-inlined scripts; inline scripts as JavaScript; `data-*` URLs as a request of unknown method | URLs from model variables or built inside expressions, fragment parameters, other template engines, htmx, Alpine or Vue attributes, a `th:method` other than GET or POST (its method depends on whether Spring's hidden-method filter is on, so it is `*`) |
| handler reach | TypeScript and JavaScript; a Spring page handler's literal view name, at Spring Boot's default template location | other view resolvers, view names built at run time |

The configuration reference (`skills/flow-atlas/references/config.md`) gives the exact reading of each style.

A finding about absence is limited by this scope. "No caller" and "no route serves this call" mean none among the
configured and readable call sites. Declare surfaces served outside the repository in `publicSurfaces`, and record a
decision as an exception.

Rules that keep the scope:

1. A new syntax is read only when a standard or the framework's documentation fixes its meaning and its value is a
   literal. Otherwise it goes into the "not read" column.
2. A framework-emitted description is preferred to reading the framework's code.
3. Where a reading cannot settle a value, it stops and says so (coverage, limits); it does not split, guess or default
   to something that looks plausible.

## Possible extensions

None of these is committed. Each fits the decision above and would be taken up when a real repository needs it.

- **Routes from Spring Boot Actuator.** Read the JSON of `/actuator/mappings`, generated like springdoc's document in a
  test, as a route source. It includes functional routes and composed annotations, and would replace reading Spring
  annotations where an application can produce it.
- **Observed calls.** Read a HAR file from Playwright end-to-end runs, or OpenTelemetry spans with `http.route`, as
  calls with evidence `observed`. This covers what static reading does not: URLs from variables, other template
  engines, client wrappers.
- **Page routes in the Arazzo export.** Write, per component, an OpenAPI document of the routes its authored document
  leaves out (server-rendered pages), so every flow step becomes an Arazzo operation and the whole flow renders in an
  Arazzo viewer. A trial on the Spring application rendered both flows completely in Arazzo UI, with one participant
  per component when each component has one source description.
- **Unknown connections.** Report a step pair the code shows no link for as `Connected: Unknown` when a step's side is
  outside the readable scope, rather than `False`.
- **Running the flows.** Hand the exported Arazzo to Redocly Respect or the Jentic runner, so a flow is checked by
  executing it as well as against the code.
- **Bridges.** Publish routes and flows to a Backstage catalog, or read Pact contracts as declared calls.

## Before widening the scope

Measure, on at least two repositories over two to four weeks:

1. how often an agent's `query` or `trace` before a change led it to reuse an existing endpoint instead of adding one;
2. the share of findings people acted on; a rule below 70% is turned off or narrowed;
3. the time spent per supported framework on reading changes.

If the first is close to zero, atlas should shrink to the flow check and the Arazzo export.

## Sources

- Bakhtin, Li, Soldani, Brogi, Cerny, Scandariato, Taibi. Comparison of Static Analysis Architecture Recovery Tools
  for Microservice Applications. arXiv:2403.06941 (registered report), results arXiv:2412.08352.
- Schneider, Scandariato. Automatic extraction of security-rich dataflow diagrams for microservice applications
  written in Java (Code2DFD). Journal of Systems and Software, 2023.
- tieline: https://github.com/nugehs/tieline
- Spring Boot Actuator mappings endpoint: https://docs.spring.io/spring-boot/api/rest/actuator/mappings.html
- Encore Flow: https://github.com/encoredev/encore/blob/main/docs/ts/observability/flow.md
- OpenTelemetry service graph connector:
  https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/connector/servicegraphconnector/README.md
- mitmproxy2swagger: https://github.com/alufers/mitmproxy2swagger
- Optic (archived): https://github.com/opticdev/optic
- Redocly Respect: https://github.com/Redocly/redocly-cli/blob/main/docs/%40v2/commands/respect.md
- Jentic Arazzo tools and Arazzo UI: https://github.com/jentic/jentic-arazzo-tools, https://arazzo-ui.jentic.com
- Pact: https://docs.pact.io/
- GitHub Spec Kit: https://github.com/github/spec-kit; OpenSpec: https://github.com/Fission-AI/OpenSpec
- Speakeasy `extract-openapi-from-code` skill:
  https://github.com/speakeasy-api/sdk-generation-skills/blob/master/skills/extract-openapi-from-code/SKILL.md
- Anthropic skills: https://github.com/anthropics/skills
- Spring Modulith documentation: https://docs.spring.io/spring-modulith/reference/documentation.html
- De Michele, Tantithamthavorn. Documentation Drift in AI-Generated Pull Requests. arXiv:2610.27381.
- Sadowski, van Gogh, Jaspan, Söderberg, Winter. Lessons from Building Static Analysis Tools at Google. CACM 61(4),
  2018. https://cacm.acm.org/research/lessons-from-building-static-analysis-tools-at-google/
