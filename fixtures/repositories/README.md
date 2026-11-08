# What atlas reads in public repositories

Each directory here pins a public repository at one commit and keeps what atlas read there, so a change to atlas's
reading shows on real code, not only on fixtures written for a case:

- `repository.yaml`: the repository's GitHub URL and the full commit.
- `atlas.config.yaml`: the configuration a user would write for it, from what `atlas inventory` offers and the code
  says (comments name where). It reads the repository's code only; a document the project generates and does not
  commit is not used.
- `snapshot.json`: what atlas read, one entry a line: the surfaces (implicit ones marked), the calls with their place,
  the edges, the findings' keys and the limits.

`node scripts/repositories.mjs` fetches each repository at its commit into `.repos/<name>` (not committed);
`test/repositories.test.ts` scans each fetched one and fails on any difference from its snapshot, and skips the
repositories not fetched, so `pnpm test` needs no network. The `repositories` workflow fetches them all and runs it on
every pull request that changes atlas's code. A difference that is meant is accepted by writing the snapshots again,
`ATLAS_UPDATE_SNAPSHOTS=1 pnpm vitest run test/repositories.test.ts`, and committing them with the change; the diff
shows what it moves.

To add a repository: a directory with `repository.yaml` and `atlas.config.yaml`, then `node scripts/repositories.mjs
<name>` and the command above.

| Repository | Shape |
|---|---|
| `spring-petclinic` | Spring Boot MVC with Thymeleaf templates as its client |
| `full-stack-fastapi-template` | FastAPI with APIRouters under a settings prefix, a React app on a generated client |
| `taxonomy` | a Next.js App Router app with route handlers, pages and a Pages Router API route |
| `ghostfolio` | an Nx monorepo: NestJS under a global prefix and URI versioning, Angular HttpClient services |
| `django-react-boilerplate` | Django REST framework (not read) and a React frontend |
| `node-express-realworld-example-app` | an Express API of chained routers, the RealWorld backend |
