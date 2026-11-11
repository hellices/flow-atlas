import ts from "typescript";
import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { Constants } from "../src/extract/constants.js";
import { extractRoutes } from "../src/extract/routes.js";
import type { Source } from "../src/source.js";

const memory = (files: Record<string, string>): Source => ({
  ref: "WORKTREE",
  list: () => Object.keys(files),
  read: (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : undefined),
  asOf: () => "2026-11-01T00:00:00Z",
});

/** What `probe` (or each `probeN`) is initialized with, read from `src/main.ts` among `files`. */
const probes = (files: Record<string, string>, main = "src/main.ts"): Record<string, string | string[] | undefined> => {
  const constants = new Constants(memory(files));
  const sf = ts.createSourceFile(main, files[main]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Record<string, string | string[] | undefined> = {};
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.name.text.startsWith("probe")) continue;
      const list = constants.elements(d.initializer);
      out[d.name.text] = list ? list.map((e) => constants.text(e) ?? "?") : constants.text(d.initializer);
    }
  }
  return out;
};

describe("constants read across files", () => {
  it("reads literals, templates and `+` of them, and the `const`s of the file that hold them", () => {
    const main = [
      'const base = "api";',
      "const version = 2;",
      "let mutable = 'x';",
      "const probe1 = `/${base}/v${version}`;",
      'const probe2 = "/" + base + "/" + version + 1;',
      "const probe3 = 1 + 2 + '/a';",
      "const probe4 = `${mutable}`;",
      "const probe5 = [base, `${base}/x`, ...rest];",
      "function f(base: string) { const probe = base; }",
      "const probe6 = `${true}`;",
      "const probe7 = 1.5e21 + '';",
    ].join("\n");
    expect(probes({ "src/main.ts": main })).toEqual({
      probe1: "/api/v2",
      probe2: "/api/21",
      probe3: "3/a",
      probe4: undefined,
      probe5: ["api", "api/x", "?"],
      probe6: undefined,
      probe7: "1.5e+21",
    });
  });

  it("reads enum members as TypeScript gives them values: literals and the auto-increment after a number", () => {
    const enums = [
      "export enum Path { Users = 'users', Orders = `orders`, ['Quoted'] = 'quoted' }",
      "export enum Code { A, B, C = 10, D, E = -2, F }",
      "export enum Mixed { S = 's', T }",
      "export enum Computed { X = 'x'.length, Y, Z = 'z' }",
      "export const enum Inlined { A, B }",
      "export enum Merged { A = 'a' }",
      "export enum Merged { B = 'b' }",
    ].join("\n");
    const main = [
      "import { Path, Code, Mixed, Computed, Inlined, Merged } from './enums';",
      "const probeUsers = Path.Users;",
      "const probeOrders = Path['Orders'];",
      "const probeQuoted = Path.Quoted;",
      "const probeCodes = `${Code.A}${Code.B}/${Code.C}/${Code.D}/${Code.E}/${Code.F}`;",
      // A numeric enum maps its values back to its names at run time; a const enum keeps no object.
      "const probeReverse = Code[11];",
      "const probeInlined = `${Inlined.B}`;",
      "const probeInlinedReverse = Inlined[1];",
      // After a string member, TypeScript gives none; after a member it computes, atlas reads none.
      "const probeMixed = `${Mixed.T}`;",
      "const probeComputedX = `${Computed.X}`;",
      "const probeComputedY = `${Computed.Y}`;",
      "const probeComputedZ = Computed.Z;",
      "const probeMerged = Merged.A + Merged.B;",
      // What an enum's object inherits is no member.
      "const probeConstructor = Path.constructor;",
      "const probeEnum = Path;",
    ].join("\n");
    expect(probes({ "src/main.ts": main, "src/enums.ts": enums })).toEqual({
      probeUsers: "users",
      probeOrders: "orders",
      probeQuoted: "quoted",
      probeCodes: "01/10/11/-2/-1",
      probeReverse: "D",
      probeInlined: "1",
      probeInlinedReverse: undefined,
      probeMixed: undefined,
      probeComputedX: undefined,
      probeComputedY: undefined,
      probeComputedZ: "z",
      probeMerged: "ab",
      probeConstructor: undefined,
      probeEnum: undefined,
    });
  });

  it("reads an object's own property only where the object cannot change: `as const`, or frozen one level deep", () => {
    const routes = [
      "export const ROUTES = { users: '/users', nested: { orders: '/orders' }, ['computed']: '/c', 1: '/one', dup: '/first', dup: '/last' } as const;",
      "export const PLAIN = { users: '/users' };",
      "export const FROZEN = Object.freeze({ users: '/users', nested: { orders: '/orders' }, sealed: { orders: '/sealed' } as const });",
      "const key = 'k';",
      "export const KEYED = { [key]: '/k' } as const;",
      "export const SPREAD_AFTER = { a: '/a', ...other } as const;",
      "export const SPREAD_BEFORE = { ...other, a: '/a' } as const;",
      "export const UNREAD_KEY = { a: '/a', [other]: '/x' } as const;",
      "export const GETTER = { get a() { return '/a'; } } as const;",
      "export const PROTO = { __proto__: { a: '/a' } } as const;",
    ].join("\n");
    const main = [
      "import { ROUTES as R, PLAIN, FROZEN, KEYED, SPREAD_AFTER, SPREAD_BEFORE, UNREAD_KEY, GETTER, PROTO } from './routes';",
      "const probeUsers = R.users;",
      "const probeNested = R.nested.orders;",
      "const probeComputed = R['computed'];",
      "const probeNumeric = R[1];",
      "const probeDup = R.dup;",
      "const probePlain = PLAIN.users;",
      "const probeFrozen = FROZEN.users;",
      "const probeFrozenNested = FROZEN.nested.orders;",
      "const probeFrozenSealed = FROZEN.sealed.orders;",
      "const probeKeyed = KEYED.k;",
      "const probeSpreadAfter = SPREAD_AFTER.a;",
      "const probeSpreadBefore = SPREAD_BEFORE.a;",
      "const probeUnreadKey = UNREAD_KEY.a;",
      "const probeGetter = GETTER.a;",
      "const probeProto = PROTO.a;",
      "const probeConstructor = R.constructor;",
      "const probeToString = R.toString;",
    ].join("\n");
    expect(probes({ "src/main.ts": main, "src/routes.ts": routes })).toEqual({
      probeUsers: "/users",
      probeNested: "/orders",
      probeComputed: "/c",
      probeNumeric: "/one",
      probeDup: "/last",
      probePlain: undefined,
      probeFrozen: "/users",
      probeFrozenNested: undefined,
      probeFrozenSealed: "/sealed",
      probeKeyed: "/k",
      probeSpreadAfter: undefined,
      probeSpreadBefore: "/a",
      probeUnreadKey: undefined,
      probeGetter: undefined,
      probeProto: undefined,
      probeConstructor: undefined,
      probeToString: undefined,
    });
  });

  it("follows imports through default, namespace and aliased imports, re-exports and `export *`", () => {
    const files = {
      "src/a.ts": "export const A = '/a';\nconst hidden = '/h';\nexport { hidden as H };\nexport default '/default';\nexport let L = '/l';",
      "src/b.ts": "export const A = '/other';",
      "src/barrel.ts": "export { A as B } from './a';\nexport * from './c';\nexport * as ns from './a';",
      "src/c.ts": "export const C = '/c';",
      "src/ambiguous.ts": "export * from './a';\nexport * from './b';",
      "src/one.ts": "export * from './a';\nexport * from './barrel2';",
      "src/barrel2.ts": "export * from './a';",
      "src/types.ts": "export const T = '/t';",
      "src/main.ts": [
        "import D, { A as Renamed, H, L } from './a.js';",
        "import * as all from './a';",
        "import { B, C, ns } from './barrel';",
        "import { A as Amb } from './ambiguous';",
        "import { A as Same } from './one';",
        "import type { T } from './types';",
        "import { type T as T2 } from './types';",
        "import { X } from './missing';",
        "const probeDefault = D;",
        "const probeRenamed = Renamed;",
        "const probeHidden = H;",
        "const probeLet = L;",
        "const probeNamespace = all.A;",
        "const probeReexported = B;",
        "const probeStar = C;",
        "const probeStarAs = ns.A;",
        // Two `export *` that give a name differently export neither; the same binding twice is that binding.
        "const probeAmbiguous = Amb;",
        "const probeSame = Same;",
        "const probeTypeOnly = T;",
        "const probeTypeOnly2 = T2;",
        "const probeMissing = X;",
      ].join("\n"),
    };
    expect(probes(files)).toEqual({
      probeDefault: "/default",
      probeRenamed: "/a",
      probeHidden: "/h",
      probeLet: undefined,
      probeNamespace: "/a",
      probeReexported: "/a",
      probeStar: "/c",
      probeStarAs: "/a",
      probeAmbiguous: undefined,
      probeSame: "/a",
      probeTypeOnly: undefined,
      probeTypeOnly2: undefined,
      probeMissing: undefined,
    });
    // An object `export default` gives may be changed by any module that imports it, unless it is `as const`.
    const objects = { "src/a.ts": "export default { a: '/a' };", "src/b.ts": "export default { b: '/b' } as const;", "src/main.ts": "import A from './a';\nimport B from './b';\nconst probeA = A.a;\nconst probeB = B.b;" };
    expect(probes(objects)).toEqual({ probeA: undefined, probeB: "/b" });
  });

  it("ends cycles of imports and constants unread, and leaves a value that grows past its bound unread", () => {
    const files = {
      "src/x.ts": "export { Y as X } from './y';\nexport const SELF = SELF2;\nexport const SELF2 = SELF;",
      "src/y.ts": "export { X as Y } from './x';\nexport * from './z';",
      "src/z.ts": "export * from './y';",
      "src/o.ts": "export const O = { a: O.b, b: O.a, c: `${O.c}` } as const;\nexport const K = { [K.y]: 'a', x: 'b' } as const;",
      "src/main.ts": [
        "import { X, SELF } from './x';",
        "import { O, K } from './o';",
        "const probeKey = K.y;",
        "const probeKeyAfter = K.x;",
        "const probeObject = O.a;",
        "const probeObjectSelf = O.c;",
        "import { Q } from './z';",
        "const probeCycle = X;",
        "const probeStarCycle = Q;",
        "const probeSelf = SELF;",
        "const a0 = 'abcdefgh';",
        ...Array.from({ length: 10 }, (_, i) => `const a${i + 1} = \`\${a${i}}\${a${i}}\`;`),
        "const probeBounded = a7;",
        "const probeRunaway = a10;",
      ].join("\n"),
    };
    expect(probes(files)).toEqual({ probeKey: undefined, probeKeyAfter: "b", probeObject: undefined, probeObjectSelf: undefined, probeCycle: undefined, probeStarCycle: undefined, probeSelf: undefined, probeBounded: "abcdefgh".repeat(128), probeRunaway: undefined });
  });

  it("resolves `paths` and `baseUrl` of the nearest tsconfig.json, with what it extends, as TypeScript does", () => {
    const files = {
      "tsconfig.base.json": '{\n  // comments and trailing commas, as tsc reads them\n  "compilerOptions": { "paths": { "@lib/*": ["libs/*/src/index.ts"], "@exact": ["libs/exact.ts"], }, },\n}',
      "app/tsconfig.json": '{ "extends": "../tsconfig.base", "compilerOptions": {} }',
      "app/src/main.ts": [
        "import { LIB } from '@lib/common';",
        "import { EXACT } from '@exact';",
        "import { NONE } from '@lib/none';",
        "const probeLib = LIB;",
        "const probeExact = EXACT;",
        "const probeNone = NONE;",
      ].join("\n"),
      "libs/common/src/index.ts": "export const LIB = '/lib';",
      "libs/exact.ts": "export const EXACT = '/exact';",
      "server/tsconfig.json": '{ "compilerOptions": { "paths": { "src/*": ["./src/*"], "src/deep/*": ["./deep/*"] } } }',
      "server/src/main.ts": "import { A } from 'src/constants.js';\nimport { D } from 'src/deep/d';\nconst probeAlias = A;\nconst probeLongest = D;",
      "server/src/constants.ts": "export const A = '/server';",
      "server/deep/d.ts": "export const D = '/deep';",
      "server/src/deep/d.ts": "export const D = '/not-this-one';",
      "based/tsconfig.json": '{ "compilerOptions": { "baseUrl": "./src" } }',
      "based/src/main.ts": "import { B } from 'util/b';\nconst probe = B;",
      "based/src/util/b.ts": "export const B = '/based';",
    };
    expect(probes(files, "app/src/main.ts")).toEqual({ probeLib: "/lib", probeExact: "/exact", probeNone: undefined });
    expect(probes(files, "server/src/main.ts")).toEqual({ probeAlias: "/server", probeLongest: "/deep" });
    expect(probes(files, "based/src/main.ts")).toEqual({ probe: "/based" });
  });

  it("reads a workspace package by its exports, and where its entry is built, the one declaration of the name it exports", () => {
    const shared = {
      "package.json": '{ "workspaces": { "packages": ["packages/*", "!packages/ignored"] } }',
      "packages/shared/package.json": '{ "name": "shared", "exports": { ".": "./dist/index.js", "./types": { "types": "./dist/types/index.d.ts", "import": "./dist/types.mjs" }, "./src": "./src/index.ts" } }',
      "packages/shared/src/index.ts": "export * from './types';\nexport const ROOT = '/root';",
      "packages/shared/src/types/index.ts": "export { ApiPath } from './ApiPath';\nexport { Twice } from './twice-a';",
      "packages/shared/src/types/ApiPath.ts": "export enum ApiPath { Rest = 'rest' }",
      "packages/shared/src/types/twice-a.ts": "export const Twice = '/a';",
      "packages/shared/src/types/twice-b.ts": "export const Twice = '/b';",
      "packages/shared/src/types/outside.ts": "export { Outside } from 'elsewhere';",
      "packages/shared/src/types/outside-local.ts": "export const Outside = '/o';",
      "packages/shared/nested/package.json": '{ "name": "nested" }',
      "packages/shared/nested/n.ts": "export const ApiPath = 'nested';",
      "packages/ignored/package.json": '{ "name": "ignored" }',
      "packages/ignored/src/index.ts": "export const IGNORED = '/ignored';",
      "other/package.json": '{ "name": "other" }',
      "other/index.ts": "export const OTHER = '/other';",
      "packages/server/src/main.ts": [
        "import { ApiPath, Twice, Outside } from 'shared/types';",
        "import { ROOT } from 'shared';",
        "import { ROOT as FromSource } from 'shared/src';",
        "import { ApiPath as Unexported } from 'shared/unexported';",
        "import { IGNORED } from 'ignored';",
        "import { OTHER } from 'other';",
        "const probeEnum = `/${ApiPath.Rest}`;",
        "const probeRoot = ROOT;",
        "const probeSource = FromSource;",
        "const probeTwice = Twice;",
        "const probeOutside = Outside;",
        "const probeUnexported = Unexported.Rest;",
        "const probeIgnored = IGNORED;",
        "const probeOther = OTHER;",
      ].join("\n"),
    };
    expect(probes(shared, "packages/server/src/main.ts")).toEqual({
      probeEnum: "/rest",
      probeRoot: "/root",
      probeSource: "/root",
      probeTwice: undefined,
      probeOutside: undefined,
      probeUnexported: undefined,
      probeIgnored: undefined,
      probeOther: undefined,
    });
  });
});

describe("NestJS paths held in constants of other files", () => {
  const routes = (files: Record<string, string>, entry: Record<string, unknown> = {}) => {
    const limits: string[] = [];
    const config = normalizeConfig({ components: [{ name: "api", path: "api" }], routes: [{ component: "api", files: ["api/src/**/*.controller.ts"], styles: ["nest"], ...entry }] });
    const ids = extractRoutes(memory(files), config, undefined, [], limits).map((s) => `${s.method} ${s.path}`);
    return { ids, limits };
  };
  const base = {
    "package.json": '{ "workspaces": ["packages/*"] }',
    "packages/shared/package.json": '{ "name": "@acme/shared", "exports": { "./types": "./dist/types.js" } }',
    "packages/shared/src/api-path.ts": "export enum ApiPath { Rest = 'rest', WellKnown = '.well-known' }",
    "api/tsconfig.json": '{ "compilerOptions": { "paths": { "src/*": ["./src/*"] } } }',
    "api/src/route-key.ts": "export enum RouteKey { Asset = 'assets', User = 'users' }\nexport const VERSIONS = ['1', '2'];\nexport let LATER = 'later';",
    "api/src/constants.ts": "export const excludePaths = ['/.well-known/acme', { path: '/custom.css', method: RequestMethod.GET }];\nexport const PREFIX = 'api';",
    "api/src/assets.controller.ts": [
      "import { ApiPath } from '@acme/shared/types';",
      "import { RouteKey as Key, VERSIONS, LATER } from 'src/route-key.js';",
      "@Controller(Key.Asset)",
      "export class AssetController {",
      "  @Get(':id') read() {}",
      "  @Get([`${ApiPath.Rest}/list`, ApiPath.WellKnown + '/acme']) list() {}",
      "  @Version(VERSIONS) @Post() create() {}",
      "  @Get(LATER) later() {}",
      "}",
    ].join("\n"),
    "api/src/custom.controller.ts": "@Controller()\nexport class CustomController {\n  @Get('custom.css') css() {}\n  @Post('custom.css') post() {}\n}",
  };

  it("reads controller and method paths, versions, the global prefix and its exclusions from constants of other files", () => {
    const files = {
      ...base,
      "api/src/main.ts": [
        "import { excludePaths, PREFIX } from './constants';",
        "async function bootstrap() {",
        "  const app = await NestFactory.create(AppModule);",
        "  app.setGlobalPrefix(PREFIX, { exclude: excludePaths });",
        "  app.enableVersioning({ type: VersioningType.URI });",
        "}",
      ].join("\n"),
    };
    expect(routes(files)).toEqual({
      ids: ["GET /api/assets/{id}", "GET /api/assets/rest/list", "GET /api/assets/.well-known/acme", "POST /api/v1/assets", "POST /api/v2/assets", "GET /custom.css", "POST /api/custom.css"],
      limits: ["routes api: api/src/assets.controller.ts:8 registers a path the file does not spell out (LATER); its routes are not read"],
    });
  });

  it("says where an exclusion held in another file is not read, at the line that holds it", () => {
    const files = {
      ...base,
      "api/src/constants.ts": "export const excludePaths = [\n  '/health',\n  `${process.env.EXTRA}`,\n];",
      "api/src/main.ts": "import { excludePaths } from './constants';\napp.setGlobalPrefix('api', { exclude: excludePaths });",
    };
    expect(routes(files).limits).toEqual([
      "routes api: api/src/constants.ts:3 excludes from the global prefix a path the file does not spell out (`${process.env.EXTRA}`); a route it excludes is read under the prefix",
      "routes api: api/src/assets.controller.ts:8 registers a path the file does not spell out (LATER); its routes are not read",
    ]);
  });

  it("reads a controller's options' path as its own property, which a spread may set", () => {
    const files = {
      "api/src/paths.ts": "export const path = 'orders';",
      "api/src/a.controller.ts": "import { path } from './paths';\n@Controller({ path, version: '1' })\nexport class A {\n  @Get() list() {}\n}",
      "api/src/b.controller.ts": "@Controller({ ...options, version: '1' })\nexport class B {\n  @Get() list() {}\n}",
    };
    expect(routes(files)).toEqual({
      ids: ["GET /orders"],
      limits: ["routes api: api/src/b.controller.ts:1 registers a path the file does not spell out ({ ...options, version: '1' }); its routes are not read"],
    });
  });

  it("reads RouterModule's paths and routes held in constants of other files", () => {
    const files = {
      "api/src/paths.ts": "export const ADMIN = 'admin';",
      "api/src/routes.ts": "import { ADMIN } from './paths';\nimport { AdminModule } from './admin.module';\nexport const routes = [{ path: ADMIN, module: AdminModule }];",
      "api/src/app.module.ts": "import { RouterModule } from '@nestjs/core';\nimport { routes } from './routes';\n@Module({ imports: [RouterModule.register(routes)] })\nexport class AppModule {}",
      "api/src/admin.module.ts": "import { UsersController } from './users.controller';\n@Module({ controllers: [UsersController] })\nexport class AdminModule {}",
      "api/src/users.controller.ts": "@Controller('users')\nexport class UsersController {\n  @Get() list() {}\n}",
    };
    expect(routes(files, { files: ["api/src/**/*.ts"] })).toEqual({ ids: ["GET /admin/users"], limits: [] });
  });
});
