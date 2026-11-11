import type { RouteSource } from "../config.js";
import type { Dispatch, Place, Surface } from "../model.js";
import { surfaceId } from "../model.js";
import { matcher, type Source } from "../source.js";
import type { Token } from "./csharp.js";
import { argumentsOf, genericClose, lineAt, readCsFile, skip, type Argument, type Attribute, type CsFile, type MethodDecl, type TypeDecl } from "./csharpdecls.js";
import { constraintPattern, parsePattern, precedence, servedPaths, type PatternSegment } from "./routepattern.js";
import type { Spans } from "./spans.js";

/**
 * ASP.NET Core's routes, read from C# (the `aspnetcore` style): minimal APIs mapped on the application and the groups
 * `MapGroup` makes from it, through the extension and static methods the code passes them to; controllers' attribute
 * routes and the conventional routes `MapControllerRoute` gives the controllers that have none; and what the framework
 * serves by itself where the code maps it (static files, the OpenAPI document, health checks). Each path is read as
 * ASP.NET Core's route template syntax gives it (`routepattern.ts`), and each route is matched as its endpoint routing
 * picks: by `Order`, then precedence, then a route that names the method before one that takes any.
 *
 * Grounds: learn.microsoft.com/aspnet/core/fundamentals/routing, minimal-apis/route-handlers, mvc/controllers/routing,
 * fundamentals/map-static-files; aspnetcore src/Http/Routing (EndpointRouteBuilderExtensions, RouteGroupBuilder,
 * DfaMatcherBuilder, EndpointComparer, RoutePrecedence), src/Mvc/Mvc.Core (ControllerFeatureProvider,
 * DefaultApplicationModelProvider, ActionAttributeRouteModel, AttributeRouteModel, ActionEndpointFactory,
 * ControllerActionEndpointDataSource), src/Http/Routing/src/Patterns/DefaultRoutePatternTransformer.
 */

type Value =
  /** A route builder: the application (no prefix) or a group, with the templates of the groups from the application. */
  | { kind: "builder"; prefix: string[] }
  /** A `WebApplicationBuilder`, whose `Build()` is the application. */
  | { kind: "host" }
  | { kind: "string"; text: string }
  /** A type named in code, for its static methods. */
  | { kind: "type"; name: string }
  | { kind: "unknown"; why: string };

const unknown = (why: string): Value => ({ kind: "unknown", why });

/** The methods that return the builder they are called on (`TBuilder`), adding metadata or conventions only. */
const CONVENTIONS = new Set([
  "RequireAuthorization", "AllowAnonymous", "RequireCors", "RequireHost", "WithTags", "WithName", "WithDisplayName", "WithDescription",
  "WithSummary", "WithMetadata", "WithGroupName", "WithOpenApi", "AddEndpointFilter", "AddEndpointFilterFactory", "RequireRateLimiting",
  "DisableRateLimiting", "CacheOutput", "DisableAntiforgery", "WithRequestTimeout", "DisableRequestTimeout", "ExcludeFromDescription",
  "Produces", "ProducesProblem", "ProducesValidationProblem", "Accepts", "WithFormOptions", "ShortCircuit", "DisableHttpMetrics",
  "WithHttpLogging", "DisableValidation", "WithResponseCache",
  // Asp.Versioning (IEndpointConventionBuilderExtensions): versions are metadata, not part of the path.
  "HasApiVersion", "HasDeprecatedApiVersion", "MapToApiVersion", "IsApiVersionNeutral", "ReportApiVersions", "AdvertisesApiVersion",
  "AdvertisesDeprecatedApiVersion", "WithApiVersionSet",
]);

/** `MapGet` and its kind (`EndpointRouteBuilderExtensions`): the method each registers. */
const VERBS: Record<string, string> = { MapGet: "GET", MapPost: "POST", MapPut: "PUT", MapDelete: "DELETE", MapPatch: "PATCH" };

/** `HttpMethods.Get` and the others (Microsoft.AspNetCore.Http.HttpMethods). */
const HTTP_METHODS: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE", Patch: "PATCH", Head: "HEAD", Options: "OPTIONS", Trace: "TRACE", Connect: "CONNECT",
};

/** Builder types a parameter may be declared with, whose routes depend on what its callers pass. */
const BUILDER_TYPES = /^(?:Microsoft\.AspNetCore\.(?:Routing|Builder)\.)?(?:IEndpointRouteBuilder|RouteGroupBuilder|WebApplication|IApplicationBuilder|IVersionedEndpointRouteBuilder)\??$/;

/** Calls on a builder that map what atlas does not read, with why. */
const NOT_READ: Record<string, string> = {
  MapRazorPages: "the Razor Pages it maps are not read",
  MapRazorComponents: "the Razor components (Blazor) it maps are not read",
  MapBlazorHub: "the Blazor hub it maps is not read",
  MapHub: "the SignalR hub it maps is not read",
  MapGrpcService: "the gRPC service it maps is not read",
  MapDynamicControllerRoute: "a dynamic route picks its controller at run time; it is not read",
  MapDynamicPageRoute: "a dynamic route picks its page at run time; it is not read",
  MapForwarder: "YARP's forwarder is not read",
  MapReverseProxy: "YARP's routes come from its configuration; they are not read",
  MapIdentityApi: "the Identity API endpoints it maps are not read",
  MapFallbackToPage: "the Razor Page it falls back to is not read",
  MapFallbackToAreaPage: "the Razor Page it falls back to is not read",
  UsePathBase: "the routes are also served under the path base it strips; that is not read",
  UseDefaultFiles: "the default files it serves at directories' paths are not read",
  UseFileServer: "the files it serves are not read",
  UseDirectoryBrowser: "the directory listings it serves are not read",
};

export interface Model {
  files: CsFile[];
  types: TypeDecl[];
  typesByName: Map<string, TypeDecl[]>;
  methodsByName: Map<string, MethodDecl[]>;
}

export function csharpModel(texts: Map<string, string>): Model {
  const files = [...texts].map(([file, text]) => readCsFile(file, text));
  const types = files.flatMap((f) => f.types);
  const typesByName = new Map<string, TypeDecl[]>();
  const methodsByName = new Map<string, MethodDecl[]>();
  for (const t of types) {
    (typesByName.get(t.name) ?? typesByName.set(t.name, []).get(t.name)!).push(t);
    for (const m of t.methods) (methodsByName.get(m.name) ?? methodsByName.set(m.name, []).get(m.name)!).push(m);
  }
  return { files, types, typesByName, methodsByName };
}

/** Where code is evaluated: a file's token range, the type it is in, and what its parameters are bound to. */
interface Ctx {
  model: Model;
  file: CsFile;
  type?: TypeDecl;
  method?: MethodDecl;
  region: [number, number];
  params: Map<string, Value>;
  stack: string[];
}

const methodKey = (m: MethodDecl): string => `${m.owner.file.file}#${m.at}`;
const tok = (f: CsFile, i: number): Token | undefined => f.tokens[i];
const isP = (t: Token | undefined, text: string): boolean => !!t && t.kind === "punct" && t.text === text;
const isWord = (t: Token | undefined, text?: string): boolean => !!t && t.kind === "id" && (text === undefined || t.text === text);

/** The lambdas of a region: their parameters, their body, and the token they start at. */
interface Lambda {
  params: string[];
  start: number;
  body: [number, number];
}

const lambdaCache = new WeakMap<CsFile, Lambda[]>();

function lambdas(f: CsFile): Lambda[] {
  const cached = lambdaCache.get(f);
  if (cached) return cached;
  const out: Lambda[] = [];
  f.tokens.forEach((t, a) => {
    if (!isP(t, "=>")) return;
    let params: string[];
    let start: number;
    if (isWord(tok(f, a - 1))) {
      params = [tok(f, a - 1)!.text];
      start = a - 1;
    } else if (isP(tok(f, a - 1), ")") && f.opens.has(a - 1)) {
      start = f.opens.get(a - 1)!;
      params = argumentsOf(f, start).flatMap((p) => {
        // The name is the last word before any default value.
        let e = p.start;
        while (e < p.end && !isP(tok(f, e), "=")) e = skip(f, e);
        const name = tok(f, e - 1);
        return name && isWord(name) ? [name.text] : [];
      });
    } else return;
    // A member's expression body (`int X => 1;`) is read as one too; it holds no region it could stand in.
    let end: number;
    if (isP(tok(f, a + 1), "{") && f.pairs.has(a + 1)) end = f.pairs.get(a + 1)! + 1;
    else {
      end = a + 1;
      while (end < f.tokens.length && ![",", ")", ";", "]", "}"].some((p) => isP(tok(f, end), p))) end = skip(f, end);
    }
    out.push({ params, start, body: [a + 1, end] });
  });
  lambdaCache.set(f, out);
  return out;
}

/**
 * Where an expression ending just before `end` starts: a chain of names, member accesses, calls, type arguments and
 * indexers, read back from its end.
 */
function chainStart(f: CsFile, end: number): number {
  let k = end - 1;
  for (;;) {
    const t = tok(f, k);
    if (!t) return k + 1;
    if ((isP(t, ")") || isP(t, "]")) && f.opens.has(k)) {
      const open = f.opens.get(k)!;
      const before = tok(f, open - 1);
      if (isWord(before) || isP(before, ">") || isP(before, "]") || isP(before, ")") || isP(before, "!")) {
        k = open - 1;
        continue;
      }
      return open;
    }
    if (isP(t, ">")) {
      // Type arguments of a generic method: back to the name before the `<`.
      let depth = 0;
      let b = k;
      for (; b >= 0; b--) {
        if (isP(tok(f, b), ">")) depth++;
        else if (isP(tok(f, b), "<") && --depth === 0) break;
      }
      if (b < 0 || genericClose(f, b) !== k) return k + 1;
      k = b - 1;
      continue;
    }
    if (isP(t, "!")) {
      k--;
      continue;
    }
    if (isWord(t) || t.kind === "str") {
      const before = tok(f, k - 1);
      if (isP(before, ".") || isP(before, "?.")) {
        k -= 2;
        continue;
      }
      if (isP(before, "::")) {
        k -= 2;
        continue;
      }
      // `new` before a name makes an object, `await` waits for one: both start the expression there.
      return k;
    }
    return k + 1;
  }
}

/** A string expression's value: literals, constants, `nameof`, concatenation and interpolation of those. */
function stringOf(ctx: Ctx, tokens: Token[], start: number, end: number, at: number, f?: CsFile, seen = new Set<string>()): string | undefined {
  const parts = splitTop(tokens, start, end, "+");
  if (parts.length > 1) {
    const each = parts.map(([s, e]) => stringOf(ctx, tokens, s, e, at, f, seen));
    return each.every((x) => x !== undefined) ? each.join("") : undefined;
  }
  if (end - start === 1 && tokens[start]?.kind === "str") {
    const t = tokens[start];
    let out = "";
    for (const p of t.parts ?? []) {
      if (typeof p === "string") out += p;
      else {
        const v = stringOf(ctx, p, 0, p.length, at, undefined, seen);
        if (v === undefined) return undefined;
        out += v;
      }
    }
    return out;
  }
  if (isP(tokens[start], "(") && isP(tokens[end - 1], ")")) return stringOf(ctx, tokens, start + 1, end - 1, at, f, seen);
  if (isWord(tokens[start], "nameof") && isP(tokens[start + 1], "(") && isP(tokens[end - 1], ")")) {
    const names = tokens.slice(start + 2, end - 1).filter((x) => x.kind === "id");
    return names.length ? names[names.length - 1]!.text : undefined;
  }
  const words = tokens.slice(start, end);
  if (words.length === 3 && isWord(words[0], "string") && isP(words[1], ".") && isWord(words[2], "Empty")) return "";
  // A constant: a local or member of this type by its name, or a member of another type by `Type.Name`.
  if (words.length === 1 && isWord(words[0])) {
    const v = f && f === ctx.file ? lookup(ctx, words[0]!.text, start) : lookup(ctx, words[0]!.text, at);
    if (v?.kind === "string") return v.text;
    return constOf(ctx, ctx.type, words[0]!.text, seen);
  }
  if (words.length >= 3 && words.every((w, i) => (i % 2 ? isP(w, ".") : isWord(w)))) {
    const typeName = ctx.file.aliases.get(words[words.length - 3]!.text) ?? words[words.length - 3]!.text;
    const name = words[words.length - 1]!.text;
    if (words.length === 3 && typeName === "HttpMethods" && Object.hasOwn(HTTP_METHODS, name)) return HTTP_METHODS[name];
    const types = ctx.model.typesByName.get(typeName) ?? [];
    const found = [...new Set(types.map((t) => constOf(ctx, t, name, seen)))];
    return found.length === 1 ? found[0] : undefined;
  }
  return undefined;
}

/** A constant string member of a type (or a type it is nested in), evaluated in its own file. */
function constOf(ctx: Ctx, type: TypeDecl | undefined, name: string, seen: Set<string>): string | undefined {
  if (!type || !type.consts.has(name)) return undefined;
  const key = `${type.file.file}#${type.at}#${name}`;
  // A constant that refers back to itself, through others or not, has no value.
  if (seen.has(key) || seen.size > 32) return undefined;
  const [s, e] = type.consts.get(name)!;
  const inner: Ctx = { ...ctx, file: type.file, type, region: [s, e], params: new Map() };
  return stringOf(inner, type.file.tokens, s, e, s, type.file, new Set([...seen, key]));
}

/** The ranges between top-level separators `sep` in `tokens[start, end)`. */
function splitTop(tokens: Token[], start: number, end: number, sep: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    const t = tokens[i]!;
    if (t.kind === "punct" && "([{".includes(t.text)) depth++;
    else if (t.kind === "punct" && ")]}".includes(t.text)) depth--;
    else if (depth === 0 && isP(t, sep)) {
      out.push([from, i]);
      from = i + 1;
    }
  }
  out.push([from, end]);
  return out;
}

/**
 * What name `name` holds at token `at`: a parameter of a lambda around it (`UseEndpoints` gives its own the builder it
 * is called on), what the code before it in the same body assigns it, or a bound parameter of the method.
 */
function lookup(ctx: Ctx, name: string, at: number): Value | undefined {
  const f = ctx.file;
  const [rs, re] = ctx.region;
  const around = lambdas(f).filter((l) => l.start >= rs && l.body[1] <= re && at >= l.body[0] && at < l.body[1]);
  around.sort((a, b) => b.start - a.start);
  for (const l of around) {
    if (!l.params.includes(name)) continue;
    // The call the lambda is an argument of: the name before the `(` it stands in.
    let open = l.start - 1;
    while (open >= rs && !(isP(tok(f, open), "(") && (f.pairs.get(open) ?? -1) >= l.body[1] - 1)) open--;
    const callee = tok(f, open - 1);
    if (callee && isWord(callee, "UseEndpoints") && isP(tok(f, open - 2), ".")) return receiverOf(ctx, open - 1);
    return unknown(`${name} is a parameter of a lambda`);
  }
  // Assignments before `at` in this body, not inside a lambda that does not hold `at`.
  const values: Value[] = [];
  for (let q = rs; q < at; q++) {
    if (!isWord(tok(f, q), name)) continue;
    const before = tok(f, q - 1);
    if (isP(before, ".") || isP(before, "?.")) continue;
    if (lambdas(f).some((l) => q >= l.body[0] && q < l.body[1] && !(at >= l.body[0] && at < l.body[1]))) continue;
    // A compound assignment, an increment, or passing it by `ref` or `out` changes it in a way not read.
    const next = tok(f, q + 1);
    if ((next?.kind === "punct" && /^(?:[-+*/%&|^]|\?\?|<<|>>)=$|^(?:\+\+|--)$/.test(next.text)) || isWord(before, "ref") || isWord(before, "out")) {
      return unknown(`${name} is changed at ${f.file}:${lineAt(f, q)} in a way atlas does not read`);
    }
    if (!isP(next, "=")) continue;
    let e = q + 2;
    while (e < re && ![";", ","].some((p) => isP(tok(f, e), p)) && !isP(tok(f, e), ")") && !isP(tok(f, e), "}")) e = skip(f, e);
    values.push(evaluate(ctx, q + 2, e));
  }
  if (values.length) {
    const keys = new Set(values.map((v) => JSON.stringify(v)));
    return keys.size === 1 ? values[0] : unknown(`${name} is assigned more than one value`);
  }
  if (ctx.params.has(name)) return ctx.params.get(name);
  if (ctx.method?.params.some((p) => p.name === name)) return unknown(`${name} is a parameter of ${ctx.method.owner.name}.${ctx.method.name}`);
  return undefined;
}

/** The value of the expression in tokens `[start, end)` of the context's file. */
function evaluate(ctx: Ctx, start: number, end: number): Value {
  const f = ctx.file;
  while (start < end && (isWord(tok(f, start), "await") || isP(tok(f, start), "!"))) start++;
  if (start >= end) return unknown("an empty expression");
  if (tok(f, start)?.kind === "str" || splitTop(f.tokens, start, end, "+").length > 1 || isWord(tok(f, start), "nameof")) {
    const s = stringOf(ctx, f.tokens, start, end, start, f);
    return s === undefined ? unknown("a string atlas does not read") : { kind: "string", text: s };
  }
  if (isP(tok(f, start), "(") && f.pairs.get(start) === end - 1) return evaluate(ctx, start + 1, end - 1);
  if (chainStart(f, end) !== start) return unknown("an expression atlas does not read");
  return chain(ctx, start, end);
}

/** The value of the chain of names, member accesses and calls in `[start, end)`. */
function chain(ctx: Ctx, start: number, end: number): Value {
  const f = ctx.file;
  const first = tok(f, start)!;
  let value: Value;
  let i = start + 1;
  if (isWord(first)) {
    const name = first.text;
    if (isP(tok(f, i), "(")) {
      // A call of a method of this type: `Map(app)`.
      value = callValue(ctx, undefined, start, f.pairs.get(i) ?? i);
      i = (f.pairs.get(i) ?? i) + 1;
    } else {
      const local = lookup(ctx, name, start);
      if (local) value = local;
      else {
        const c = constOf(ctx, ctx.type, name, new Set());
        // A type may be named through a `using` alias.
        value = c !== undefined ? { kind: "string", text: c } : { kind: "type", name: f.aliases.get(name) ?? name };
      }
    }
  } else return unknown("an expression atlas does not read");
  while (i < end) {
    if (isP(tok(f, i), "!")) {
      i++;
      continue;
    }
    if (!(isP(tok(f, i), ".") || isP(tok(f, i), "?.") || isP(tok(f, i), "::")) || !isWord(tok(f, i + 1))) return unknown("an expression atlas does not read");
    const nameAt = i + 1;
    let k = nameAt + 1;
    const g = genericClose(f, k, end);
    if (g !== undefined) k = g + 1;
    if (isP(tok(f, k), "(") && f.pairs.has(k)) {
      value = step(ctx, value, nameAt, k);
      i = f.pairs.get(k)! + 1;
    } else {
      // A member that is not called: a type's constant, a namespace or type name, or a property.
      const name = tok(f, nameAt)!.text;
      if (value.kind === "type") {
        const c = (ctx.model.typesByName.get(value.name) ?? []).map((t) => constOf(ctx, t, name, new Set())).find((x) => x !== undefined);
        value = c !== undefined ? { kind: "string", text: c } : { kind: "type", name };
      } else value = unknown(`${tok(f, nameAt)!.text} is a property atlas does not read`);
      i = k;
    }
  }
  return value;
}

/** The value of the call whose name is at `nameAt` and `(` at `open`, on `value`. */
function step(ctx: Ctx, value: Value, nameAt: number, open: number): Value {
  const f = ctx.file;
  const name = tok(f, nameAt)!.text;
  if (value.kind === "unknown" || value.kind === "string") return value.kind === "unknown" ? value : unknown(`${name} is called on a string`);
  // `WebApplication` is ASP.NET Core's unless the files declare a type of that name.
  if (value.kind === "type" && value.name === "WebApplication" && !ctx.model.typesByName.has("WebApplication")) {
    // WebApplication.CreateBuilder and its kind make a WebApplicationBuilder; Create makes the application.
    if (["CreateBuilder", "CreateSlimBuilder", "CreateEmptyBuilder"].includes(name)) return { kind: "host" };
    if (name === "Create") return { kind: "builder", prefix: [] };
  }
  if (value.kind === "host") return name === "Build" ? { kind: "builder", prefix: [] } : unknown(`${name} is called on the WebApplicationBuilder`);
  if (value.kind === "builder") {
    if (name === "MapGroup") {
      const arg = argumentsOf(f, open)[0];
      const prefix = arg ? stringOf(ctx, f.tokens, arg.start, arg.end, arg.start, f) : undefined;
      return prefix === undefined ? unknown(`MapGroup at ${f.file}:${lineAt(f, nameAt)} is given a prefix atlas does not read`) : { kind: "builder", prefix: [...value.prefix, prefix] };
    }
    if (name === "WithOrder") return unknown(`WithOrder at ${f.file}:${lineAt(f, nameAt)} sets the Order of a group's routes, which is not read`);
    // Asp.Versioning's NewVersionedApi is a group without a prefix (`MapGroup(string.Empty)`).
    if (CONVENTIONS.has(name) || name === "NewVersionedApi") return value;
    if (Object.hasOwn(VERBS, name) || name.startsWith("Map")) {
      if (!ctx.model.methodsByName.has(name)) return unknown(`${name} returns no route builder`);
    }
  }
  return callValue(ctx, value, nameAt, open);
}

/** The methods of the files a call at `nameAt` may run: of this type, of a type it names, or extensions of a value. */
function candidates(ctx: Ctx, receiver: Value | undefined, nameAt: number, open: number): MethodDecl[] {
  const name = tok(ctx.file, nameAt)!.text;
  const count = argumentsOf(ctx.file, open).length;
  let list = ctx.model.methodsByName.get(name) ?? [];
  const extension = !!receiver && receiver.kind !== "type";
  if (!receiver) list = list.filter((m) => ctx.type && m.owner.name === ctx.type.name && m.owner.namespace === ctx.type.namespace);
  else if (receiver.kind === "type") list = list.filter((m) => m.owner.name === receiver.name && m.modifiers.has("static"));
  else list = list.filter((m) => m.params[0]?.self && m.modifiers.has("static"));
  const given = count + (extension ? 1 : 0);
  return list.filter((m) => !m.generic && m.body && m.params.length >= given && m.params.filter((p) => !p.optional).length <= given);
}

/** What each parameter of `m` is bound to by the call at `open`, made on `receiver`. */
function bind(ctx: Ctx, m: MethodDecl, receiver: Value | undefined, open: number): Map<string, Value> {
  const out = new Map<string, Value>();
  const extension = !!receiver && receiver.kind !== "type";
  if (extension) out.set(m.params[0]!.name, receiver);
  argumentsOf(ctx.file, open).forEach((a, i) => {
    const param = a.name !== undefined ? m.params.find((p) => p.name === a.name) : m.params[i + (extension ? 1 : 0)];
    if (param) out.set(param.name, evaluate(ctx, a.start, a.end));
  });
  return out;
}

/** The context of method `m`'s body, with its parameters bound. */
function enter(ctx: Ctx, m: MethodDecl, params: Map<string, Value>): Ctx {
  return { model: ctx.model, file: m.owner.file, type: m.owner, method: m, region: m.body!, params, stack: [...ctx.stack, methodKey(m)] };
}

const MAX_DEPTH = 12;

/** What the method a call runs returns: the value of each `return` of its body (not of a lambda in it), where they agree. */
function callValue(ctx: Ctx, receiver: Value | undefined, nameAt: number, open: number): Value {
  const name = tok(ctx.file, nameAt)!.text;
  const found = candidates(ctx, receiver, nameAt, open);
  if (found.length !== 1) return unknown(found.length ? `${name} names more than one method` : `${name} is not a method atlas reads`);
  const m = found[0]!;
  if (ctx.stack.includes(methodKey(m)) || ctx.stack.length >= MAX_DEPTH) return unknown(`${name} calls itself`);
  const inner = enter(ctx, m, bind(ctx, m, receiver, open));
  const f = m.owner.file;
  if (m.expression) return evaluate(inner, m.body![0], m.body![1]);
  const values: Value[] = [];
  for (let r = m.body![0]; r < m.body![1]; r++) {
    if (!isWord(tok(f, r), "return")) continue;
    if (lambdas(f).some((l) => r >= l.body[0] && r < l.body[1] && l.start >= m.body![0])) continue;
    let e = r + 1;
    while (e < m.body![1] && !isP(tok(f, e), ";")) e = skip(f, e);
    values.push(evaluate(inner, r + 1, e));
  }
  const keys = new Set(values.map((v) => JSON.stringify(v)));
  return keys.size === 1 ? values[0]! : unknown(`${name} returns ${values.length ? "more than one value" : "nothing atlas reads"}`);
}

/** The value of the expression a member call at `nameAt` is made on (before its `.`). */
function receiverOf(ctx: Ctx, nameAt: number): Value {
  const dot = nameAt - 1;
  const start = chainStart(ctx.file, dot);
  if (start >= dot || start < ctx.region[0]) return unknown("its receiver is not read");
  return evaluate(ctx, start, dot);
}

/** A route a call maps, before its template is read. */
interface Mapped {
  methods: string[];
  prefix: string[];
  pattern: string;
  at: Place;
  /** The endpoint's `Order`; none where a `WithOrder` not spelled out sets it. */
  order: number | undefined;
  /** For a route the framework serves by itself: its convention. */
  convention?: string;
}

interface ConventionalRoute {
  pattern: string;
  defaults: Map<string, string>;
  /** `MapAreaControllerRoute`'s area, which its route takes only. */
  area?: string;
  order: number;
  at: Place;
}

/** The controllers mapped on one builder: their attribute routes, and the conventional routes given them in order. */
interface ControllerSource {
  prefix: string[];
  conventional: ConventionalRoute[];
  at: Place;
}

class Reader {
  readonly mapped: Mapped[] = [];
  readonly sources = new Map<string, ControllerSource>();
  readonly statics: Array<{ kind: "MapStaticAssets" | "UseStaticFiles"; prefix: string[]; at: Place }> = [];
  readonly walked = new Set<string>();
  readonly said: string[] = [];
  constructor(
    readonly model: Model,
    readonly component: string,
    readonly spans: Spans | undefined,
  ) {}

  limit(f: CsFile, at: number, why: string): void {
    this.said.push(`routes ${this.component}: ${f.file}:${lineAt(f, at)} ${why}`);
  }

  /** Reads every call in the context's region, in order. */
  walk(ctx: Ctx): void {
    const f = ctx.file;
    const [rs, re] = ctx.region;
    if (ctx.method) this.walked.add(methodKey(ctx.method));
    for (let n = rs; n < re; n++) {
      if (!isWord(tok(f, n))) continue;
      let open = n + 1;
      const g = genericClose(f, open, re);
      if (g !== undefined) open = g + 1;
      if (!isP(tok(f, open), "(") || !f.pairs.has(open)) continue;
      const prev = tok(f, n - 1);
      const member = isP(prev, ".") || isP(prev, "?.");
      // A declaration (`void Map(...)`) or a constructor call (`new Map(...)`) is no call of a method.
      if (!member && prev && ((isWord(prev) && !["return", "await", "in", "else", "yield", "throw"].includes(prev.text)) || isP(prev, ">") || isP(prev, "]"))) continue;
      this.site(ctx, n, open, member);
    }
  }

  private site(ctx: Ctx, n: number, open: number, member: boolean): void {
    const f = ctx.file;
    const name = tok(f, n)!.text;
    const args = argumentsOf(f, open);
    const at: Place = { file: f.file, line: lineAt(f, n) };
    const arg = (index: number, named: string): Argument | undefined => args.find((a) => a.name === named) ?? args.filter((a) => a.name === undefined)[index];
    const text = (a: Argument | undefined): string | undefined => (a ? stringOf(ctx, f.tokens, a.start, a.end, a.start, f) : undefined);
    // `Map` is a common name: only a call whose first argument is a path is a route's.
    const path = name !== "Map" || text(arg(0, "pattern")) !== undefined || tok(f, args[0]?.start ?? -1)?.kind === "str";
    const framework = member && path && (Object.hasOwn(VERBS, name) || FRAMEWORK.has(name) || Object.hasOwn(NOT_READ, name));
    if (framework) {
      const receiver = receiverOf(ctx, n);
      if (receiver.kind === "unknown") {
        if (name.startsWith("Map") || name === "UseStaticFiles") this.limit(f, n, `${name} is called on a builder atlas does not read (${receiver.why}); what it maps is not read`);
        return;
      }
      // A name that is neither a variable nor a type of the files (a field, a property) holds what atlas does not read.
      if (receiver.kind === "type" && receiver.name !== "WebApplication" && !this.model.typesByName.has(receiver.name)) {
        this.limit(f, n, `${name} is called on ${receiver.name}, which atlas does not read; what it maps is not read`);
        return;
      }
      if (receiver.kind !== "builder") return;
      this.framework(ctx, n, open, name, receiver.prefix, at, arg, text);
      return;
    }
    // What makes or configures a builder is read where the builder is used.
    if (member && (name === "MapGroup" || name === "NewVersionedApi" || CONVENTIONS.has(name))) return;
    let receiver: Value | undefined;
    if (member) {
      receiver = receiverOf(ctx, n);
      if (receiver.kind === "unknown") {
        // An extension method of the files that maps on its builder, called on one atlas does not read.
        const maps = candidates(ctx, receiver, n, open).filter((m) => BUILDER_TYPES.test(m.params[0]!.type));
        if (maps.length) this.limit(f, n, `calls ${name} on a builder atlas does not read (${receiver.why}); the routes it maps there are not read`);
        return;
      }
      if (receiver.kind === "string" || receiver.kind === "host") return;
    }
    const found = candidates(ctx, receiver, n, open);
    if (!found.length) {
      if (receiver?.kind === "builder" && name.startsWith("Map")) this.limit(f, n, `calls ${name}, which is not among the files read; the routes it may map are not read`);
      return;
    }
    const bindings = found.map((m) => bind(ctx, m, receiver, open));
    // A builder the call passes, or one atlas does not read for a builder parameter, whose routes are then named.
    const passes = (m: MethodDecl, b: Map<string, Value>) => m.params.some((p) => b.get(p.name)?.kind === "builder" || (BUILDER_TYPES.test(p.type) && b.get(p.name)?.kind === "unknown"));
    if (!found.some((m, i) => passes(m, bindings[i]!))) return;
    if (found.length > 1) {
      this.limit(f, n, `calls ${name}, which names ${found.length} methods; the routes they map are not read`);
      return;
    }
    const m = found[0]!;
    if (ctx.stack.includes(methodKey(m)) || ctx.stack.length >= MAX_DEPTH) return;
    this.walk(enter(ctx, m, bindings[0]!));
  }

  /** A call of the framework on a builder whose prefix is read. */
  private framework(
    ctx: Ctx,
    n: number,
    open: number,
    name: string,
    prefix: string[],
    at: Place,
    arg: (index: number, named: string) => Argument | undefined,
    text: (a: Argument | undefined) => string | undefined,
  ): void {
    const f = ctx.file;
    const args = argumentsOf(f, open);
    const span = (a: Argument | undefined) => {
      if (a) this.spans?.add(f.file, f.tokens[a.start]!.start, f.tokens[a.end - 1]!.end);
    };
    const pattern = (a: Argument | undefined): string | undefined => {
      const p = text(a);
      if (p === undefined) this.limit(f, n, `${name} is given a path atlas does not read; the route is not read`);
      else span(a);
      return p;
    };
    if (Object.hasOwn(NOT_READ, name)) {
      this.limit(f, n, `calls ${name}: ${NOT_READ[name]}`);
      return;
    }
    // `WithOrder(n)` chained on the endpoint sets its Order; one not spelled out leaves it unread.
    let ordered: number | undefined | null;
    for (let i = f.pairs.get(open)! + 1; isP(tok(f, i), ".") && isWord(tok(f, i + 1)) && isP(tok(f, i + 2), "(") && f.pairs.has(i + 2); i = f.pairs.get(i + 2)! + 1) {
      if (!isWord(tok(f, i + 1), "WithOrder")) continue;
      const written = f.tokens.slice(i + 3, f.pairs.get(i + 2)).map((t) => t.text).join("");
      ordered = /^-?\d+$/.test(written) ? Number(written) : null;
    }
    if (ordered === null) this.limit(f, n, `${name}'s route is given an Order atlas does not read; which route a request reaches there is not read`);
    const order = (fallback: number) => (ordered === null ? undefined : ordered ?? fallback);
    if (Object.hasOwn(VERBS, name)) {
      const p = pattern(arg(0, "pattern"));
      if (p !== undefined) this.mapped.push({ methods: [VERBS[name]!], prefix, pattern: p, at, order: order(0) });
      return;
    }
    switch (name) {
      case "MapMethods": {
        const p = pattern(arg(0, "pattern"));
        const methods = this.methodList(ctx, arg(1, "httpMethods"));
        if (p === undefined) return;
        if (!methods) {
          this.limit(f, n, `MapMethods is given methods atlas does not read; the route is not read`);
          return;
        }
        this.mapped.push({ methods: [...new Set(methods.map((m) => m.toUpperCase()))], prefix, pattern: p, at, order: order(0) });
        return;
      }
      case "Map": {
        // IApplicationBuilder.Map(path, branch => ...) branches the middleware: a lambda of one parameter whose type is
        // not written may be either, so the call is not read.
        const handler = args[1];
        if (handler && this.untypedSingleLambda(f, handler)) {
          this.limit(f, n, `calls Map with a lambda that may branch the middleware pipeline (IApplicationBuilder.Map) or handle a route; it is not read`);
          return;
        }
        const p = pattern(arg(0, "pattern"));
        if (p !== undefined) this.mapped.push({ methods: ["*"], prefix, pattern: p, at, order: order(0) });
        return;
      }
      case "MapFallback":
      case "MapFallbackToFile":
      case "MapFallbackToController":
      case "MapFallbackToAreaController": {
        // Each falls back with `{*path:nonfile}` unless it is given a pattern first, at Order int.MaxValue
        // (FallbackEndpointRouteBuilderExtensions, StaticFilesEndpointRouteBuilderExtensions,
        // ControllerEndpointRouteBuilderExtensions).
        const strings = args.filter((a) => text(a) !== undefined).length;
        const withPattern = name === "MapFallback" ? args.length >= 2 : name === "MapFallbackToFile" ? strings >= 2 : name === "MapFallbackToController" ? strings >= 3 : strings >= 4;
        const p = withPattern ? pattern(arg(0, "pattern")) : "{*path:nonfile}";
        if (p !== undefined) this.mapped.push({ methods: ["*"], prefix, pattern: p, at, order: order(2147483647) });
        return;
      }
      case "MapHealthChecks": {
        const p = pattern(arg(0, "pattern"));
        if (p !== undefined) this.mapped.push({ methods: ["*"], prefix, pattern: p, at, order: order(0), convention: "aspnetcore MapHealthChecks" });
        return;
      }
      case "MapOpenApi": {
        // Microsoft.AspNetCore.OpenApi's document, at `/openapi/{documentName}.json` unless a pattern is given.
        const given = arg(0, "pattern");
        const p = given ? pattern(given) : "/openapi/{documentName}.json";
        if (p !== undefined) this.mapped.push({ methods: ["GET"], prefix, pattern: p, at, order: order(0), convention: "aspnetcore MapOpenApi" });
        return;
      }
      case "MapStaticAssets":
      case "UseStaticFiles": {
        if (args.length) {
          this.limit(f, n, `calls ${name} with options or another manifest; the files it serves are not read`);
          return;
        }
        this.statics.push({ kind: name, prefix, at });
        return;
      }
      case "MapControllers":
        this.source(prefix, at);
        return;
      case "MapDefaultControllerRoute":
        this.conventional(prefix, at, { pattern: "{controller=Home}/{action=Index}/{id?}", defaults: undefined });
        return;
      case "MapControllerRoute":
      case "MapAreaControllerRoute": {
        const area = name === "MapAreaControllerRoute";
        const offset = area ? 1 : 0;
        const areaName = area ? text(arg(1, "areaName")) : undefined;
        const patternArg = arg(1 + offset, "pattern");
        const p = text(patternArg);
        if (p === undefined || (area && areaName === undefined)) {
          this.limit(f, n, `${name} is given ${p === undefined ? "a pattern" : "an area"} atlas does not read; its conventional routes are not read`);
          return;
        }
        span(patternArg);
        const constraints = arg(3 + offset, "constraints");
        if (constraints && !isWord(tok(f, constraints.start), "null")) {
          this.limit(f, n, `${name} is given constraints, which atlas does not read; its conventional routes are not read`);
          return;
        }
        const defaultsArg = arg(2 + offset, "defaults");
        const defaults = defaultsArg && !isWord(tok(f, defaultsArg.start), "null") ? this.anonymous(ctx, defaultsArg) : new Map<string, string>();
        if (!defaults) {
          this.limit(f, n, `${name} is given defaults atlas does not read; its conventional routes are not read`);
          return;
        }
        this.conventional(prefix, at, { pattern: p, defaults, ...(areaName !== undefined ? { area: areaName } : {}) });
        return;
      }
    }
  }

  private source(prefix: string[], at: Place): ControllerSource {
    const key = JSON.stringify(prefix);
    return this.sources.get(key) ?? this.sources.set(key, { prefix, conventional: [], at }).get(key)!;
  }

  /** A conventional route, its order the next of the builder it is mapped on (`OrderedEndpointsSequenceProvider`, from 1). */
  private conventional(prefix: string[], at: Place, route: { pattern: string; defaults: Map<string, string> | undefined; area?: string }): void {
    const source = this.source(prefix, at);
    source.conventional.push({ pattern: route.pattern, defaults: route.defaults ?? new Map<string, string>(), ...(route.area !== undefined ? { area: route.area } : {}), order: source.conventional.length + 1, at });
  }

  /** `new { controller = "Home", action = "Index" }`, each value a string. */
  private anonymous(ctx: Ctx, a: Argument): Map<string, string> | undefined {
    const f = ctx.file;
    if (!isWord(tok(f, a.start), "new") || !isP(tok(f, a.start + 1), "{") || f.pairs.get(a.start + 1) !== a.end - 1) return undefined;
    const out = new Map<string, string>();
    for (const [s, e] of splitTop(f.tokens, a.start + 2, a.end - 1, ",")) {
      if (s === e) continue;
      if (!isWord(tok(f, s)) || !isP(tok(f, s + 1), "=")) return undefined;
      const v = stringOf(ctx, f.tokens, s + 2, e, s + 2, f);
      if (v === undefined) return undefined;
      out.set(tok(f, s)!.text, v);
    }
    return out;
  }

  /** The strings of an array, list or collection expression: `new[] { "GET" }`, `["GET", HttpMethods.Post]`. */
  private methodList(ctx: Ctx, a: Argument | undefined): string[] | undefined {
    if (!a) return undefined;
    const f = ctx.file;
    let open = a.start;
    if (!isP(tok(f, open), "[")) {
      if (!isWord(tok(f, open), "new")) return undefined;
      while (open < a.end && !isP(tok(f, open), "{")) open = skip(f, open);
    }
    if (f.pairs.get(open) !== a.end - 1) return undefined;
    const out: string[] = [];
    for (const [s, e] of splitTop(f.tokens, open + 1, a.end - 1, ",")) {
      if (s === e) continue;
      const v = stringOf(ctx, f.tokens, s, e, s, f);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out.length ? out : undefined;
  }

  private untypedSingleLambda(f: CsFile, a: Argument): boolean {
    let s = a.start;
    if (isWord(tok(f, s), "async") || isWord(tok(f, s), "static")) s++;
    if (isWord(tok(f, s)) && isP(tok(f, s + 1), "=>")) return true;
    return isP(tok(f, s), "(") && isWord(tok(f, s + 1)) && isP(tok(f, s + 2), ")") && isP(tok(f, s + 3), "=>");
  }
}

/** The calls of the framework a builder makes that atlas reads, besides `MapGet` and its kind. */
const FRAMEWORK = new Set([
  "Map", "MapMethods", "MapFallback", "MapFallbackToFile", "MapFallbackToController", "MapFallbackToAreaController", "MapHealthChecks",
  "MapOpenApi", "MapStaticAssets", "UseStaticFiles", "MapControllers", "MapDefaultControllerRoute", "MapControllerRoute", "MapAreaControllerRoute",
]);

/** The attributes that give an action or controller its routes (`IRouteTemplateProvider`), with the methods each takes. */
const ROUTE_ATTRIBUTES: Record<string, string[]> = {
  Route: [],
  HttpGet: ["GET"],
  HttpPost: ["POST"],
  HttpPut: ["PUT"],
  HttpDelete: ["DELETE"],
  HttpPatch: ["PATCH"],
  HttpHead: ["HEAD"],
  HttpOptions: ["OPTIONS"],
  AcceptVerbs: [],
};

/** One route an attribute gives: its template (none for `[HttpGet]`), `Order` and the methods it takes. */
interface RouteProvider {
  template?: string;
  order?: number;
  named: boolean;
  /** Whether it takes methods (`IActionHttpMethodProvider`): every attribute here but `[Route]`. */
  verbs: boolean;
  methods: string[];
}

/** A selector (`SelectorModel`): an attribute route, or none, and the methods it takes (none: any). */
interface Selector {
  template?: string;
  order?: number;
  methods: string[];
}

/** The routes an attribute list gives, or a reason they are not read. */
function routeProviders(ctx: Ctx, attributes: Attribute[]): RouteProvider[] | string {
  const out: RouteProvider[] = [];
  for (const a of attributes) {
    if (!Object.hasOwn(ROUTE_ATTRIBUTES, a.name)) continue;
    const f = ctx.file;
    const positional = a.args.filter((x) => x.name === undefined);
    const named = (n: string) => a.args.find((x) => x.name === n);
    const str = (x: Argument | undefined) => (x ? stringOf(ctx, f.tokens, x.start, x.end, x.start, f) : undefined);
    let template: string | undefined;
    let methods = ROUTE_ATTRIBUTES[a.name]!;
    if (a.name === "AcceptVerbs") {
      const verbs = positional.map(str);
      if (verbs.some((v) => v === undefined)) return `[AcceptVerbs] at ${f.file}:${lineAt(f, a.at)} names methods atlas does not read`;
      methods = (verbs as string[]).map((v) => v.toUpperCase());
      const route = named("Route");
      if (route) {
        template = str(route);
        if (template === undefined) return `[AcceptVerbs] at ${f.file}:${lineAt(f, a.at)} gives a route atlas does not read`;
      }
    } else {
      const written = positional[0] ?? named("template");
      if (written) {
        template = str(written);
        if (template === undefined) return `[${a.name}] at ${f.file}:${lineAt(f, a.at)} gives a template atlas does not read`;
      }
    }
    let order: number | undefined;
    const o = named("Order");
    if (o) {
      const text = f.tokens.slice(o.start, o.end).map((t) => t.text).join("");
      if (!/^-?\d+$/.test(text)) return `[${a.name}] at ${f.file}:${lineAt(f, a.at)} gives an Order atlas does not read`;
      order = Number(text);
    }
    out.push({ ...(template !== undefined ? { template } : {}), ...(order !== undefined ? { order } : {}), named: !!named("Name"), verbs: a.name !== "Route", methods });
  }
  return out;
}

/**
 * `DefaultApplicationModelProvider.CreateSelectors`: a selector for each attribute that defines a route (a template, an
 * Order or a Name), with the methods of the method attributes that define none where it is a `[Route]`, and one more for
 * those silent ones where every route-defining attribute takes methods itself.
 */
function selectors(providers: RouteProvider[]): Selector[] {
  const silent = providers.filter((p) => p.template === undefined && p.order === undefined && !p.named);
  const defining = providers.filter((p) => !silent.includes(p));
  const silentMethods = [...new Set(silent.flatMap((p) => p.methods))];
  const forSilent = silent.length > 0 && defining.every((p) => p.verbs);
  if (!defining.length) return [{ methods: silentMethods }];
  const out: Selector[] = defining.map((p) => ({
    ...(p.template !== undefined ? { template: p.template } : {}),
    ...(p.order !== undefined ? { order: p.order } : {}),
    methods: p.verbs ? p.methods : silentMethods,
  }));
  if (forSilent) out.push({ methods: silentMethods });
  return out;
}

const isOverride = (t: string | undefined): boolean => !!t && (t.startsWith("/") || t.startsWith("~/"));

/** `AttributeRouteModel.CombineTemplates`: the template of a controller route and an action route together, or none. */
function combine(left: string | undefined, right: string | undefined): string | undefined {
  let out: string | undefined;
  if (left === undefined && right === undefined) return undefined;
  if (right === undefined) out = left;
  else if (left === undefined || left === "" || left === "~/" || left === "/" || isOverride(right)) out = right;
  else out = left.endsWith("/") ? left + right : `${left}/${right}`;
  if (out === undefined || out === "//") return out;
  const start = out.startsWith("/") ? 1 : out.startsWith("~/") ? 2 : 0;
  if (start === out.length) return "";
  return out.slice(start, out.endsWith("/") ? -1 : undefined);
}

/** `AttributeRouteModel.ReplaceTokens`: `[controller]`, `[action]` and `[area]`, with `[[` and `]]` for brackets. */
function replaceTokens(template: string, values: Map<string, string>): string | { error: string } {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const c = template[i]!;
    if (c === "[" && template[i + 1] === "[") {
      out += "[";
      i += 2;
    } else if (c === "]" && template[i + 1] === "]") {
      out += "]";
      i += 2;
    } else if (c === "]") return { error: "has a ] without its [" };
    else if (c === "[") {
      let j = i + 1;
      let token = "";
      for (;;) {
        if (j >= template.length) return { error: "has a [ without its ]" };
        if (template[j] === "]" && template[j + 1] === "]") {
          token += "]";
          j += 2;
        } else if (template[j] === "]") break;
        else if (template[j] === "[") {
          if (template[j + 1] !== "[") return { error: "has a [ inside a token" };
          token += "[";
          j += 2;
        } else token += template[j++];
      }
      if (!token) return { error: "has an empty token" };
      const value = [...values].find(([k]) => k.toLowerCase() === token.toLowerCase())?.[1];
      if (value === undefined) return { error: `has a token [${token}] with no value` };
      out += value;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * `DefaultRoutePatternTransformer.SubstituteRequiredValues`: the template with each parameter that names one of an
 * action's route values matched as that value, or null where the route cannot reach the action. A parameter keeps its
 * default only where it equals the value. Undefined where a constraint it must check is not read.
 */
function substitute(segments: PatternSegment[], defaults: Map<string, string>, required: Map<string, string | null>): PatternSegment[] | null | undefined {
  const params = new Map(segments.flatMap((s) => s.flatMap((p) => ("parameter" in p ? [[p.parameter.name.toLowerCase(), p.parameter] as const] : []))));
  const same = (a: string | undefined | null, b: string | undefined | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  const defaultOf = (k: string) => [...defaults].find(([d]) => d.toLowerCase() === k.toLowerCase())?.[1];
  for (const [k, v] of required) {
    const param = params.get(k.toLowerCase());
    if (!v) {
      if (param) return null;
      const d = defaultOf(k);
      if (d !== undefined && !same(d, "")) return null;
      continue;
    }
    if (param) {
      const pattern = constraintPattern(param.constraints);
      if (pattern === undefined) return undefined;
      if (pattern !== null && !new RegExp(`^(?:${pattern})$`).test(v)) return null;
      continue;
    }
    if (defaultOf(k) !== undefined && same(defaultOf(k), v)) continue;
    return null;
  }
  return segments.map((s) =>
    s.map((p) => {
      if (!("parameter" in p)) return p;
      const v = [...required].find(([k]) => k.toLowerCase() === p.parameter.name.toLowerCase())?.[1];
      if (!v) return p;
      const d = p.parameter.default ?? defaultOf(p.parameter.name);
      const { default: _dropped, ...rest } = p.parameter;
      void _dropped;
      return { parameter: { ...rest, required: v, ...(d !== undefined && same(d, v) ? { default: d } : {}) } };
    }),
  );
}

/** A controller action: its name, route values and selectors, where it is declared. */
interface Action {
  method: MethodDecl;
  name: string;
  selectors: Selector[];
}

interface Controller {
  name: string;
  types: TypeDecl[];
  area?: string;
  /** The controller's route selectors (its `[Route]` attributes, or a base class's). */
  routes: Selector[];
  actions: Action[];
}

/** The class a base list names first, where it is a class of the files; `Controller` and `ControllerBase` are MVC's. */
type Base = { kind: "mvc" } | { kind: "none" } | { kind: "class"; types: TypeDecl[] } | { kind: "unknown"; name: string };

function baseOf(model: Model, types: TypeDecl[]): Base {
  const first = types.flatMap((t) => t.bases)[0];
  if (first === undefined) return { kind: "none" };
  if (first === "Controller" || first === "ControllerBase") return { kind: "mvc" };
  const declared = (model.typesByName.get(first) ?? []).filter((t) => t.keyword === "class" || t.keyword === "record");
  if (declared.length) return { kind: "class", types: declared };
  if ((model.typesByName.get(first) ?? []).some((t) => t.keyword === "interface") || /^I[A-Z]/.test(first)) return { kind: "none" };
  return { kind: "unknown", name: first };
}

/**
 * The controllers of the files (`ControllerFeatureProvider.IsController`): public classes, not nested, abstract or
 * generic, without `[NonController]`, named with the `Controller` suffix or marked `[Controller]`, as MVC's
 * `ControllerBase` is; and their actions (`IsAction`): public methods, not static, abstract, generic or `[NonAction]`.
 */
function controllers(model: Model, reader: Reader, suppressAsync: boolean): Controller[] {
  const groups = new Map<string, TypeDecl[]>();
  for (const t of model.types) {
    if (t.nested || (t.keyword !== "class" && t.keyword !== "record")) continue;
    const key = `${t.namespace}.${t.name}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }
  // Attributes the files declare under the name of one of MVC's, or derive from MVC's route attributes: what they
  // give is not what MVC's does, or not only.
  const mvc = [...Object.keys(ROUTE_ATTRIBUTES), "Area", "ActionName", "NonAction", "NonController", "Controller"];
  const foreign = new Set<string>();
  for (const t of model.types) {
    if (t.keyword !== "class") continue;
    const short = t.name.endsWith("Attribute") ? t.name.slice(0, -"Attribute".length) : t.name;
    const derived = t.bases.some((b) => mvc.includes(b.replace(/Attribute$/, "")) || ["HttpMethodAttribute", "IRouteTemplateProvider", "IActionHttpMethodProvider", "RouteValueAttribute"].includes(b));
    if (derived || (mvc.includes(short) && (t.name.endsWith("Attribute") || t.bases.some((b) => b.endsWith("Attribute"))))) foreign.add(short);
  }
  const out: Controller[] = [];
  for (const types of groups.values()) {
    const name = types[0]!.name;
    const mods = new Set(types.flatMap((t) => [...t.modifiers]));
    // The chain of classes from this one up to MVC's base or one the files do not declare.
    const chain: TypeDecl[][] = [types];
    let base = baseOf(model, types);
    while (base.kind === "class" && chain.length < 16 && !chain.some((c) => c === (base as { types: TypeDecl[] }).types)) {
      chain.push(base.types);
      base = baseOf(model, base.types);
    }
    const attrs = (level: TypeDecl[]) => level.flatMap((t) => t.attributes);
    const any = (n: string) => chain.some((level) => attrs(level).some((a) => a.name === n));
    if (any("NonController")) continue;
    const named = name.toLowerCase().endsWith("controller");
    const marked = any("Controller") || base.kind === "mvc";
    if (!mods.has("public") || mods.has("abstract") || mods.has("static") || types.some((t) => t.generic) || (!named && !marked && base.kind !== "unknown")) continue;
    const ownRoutes = chain.some((level) => attrs(level).some((a) => Object.hasOwn(ROUTE_ATTRIBUTES, a.name))) || types.some((t) => t.methods.some((m) => m.attributes.some((a) => Object.hasOwn(ROUTE_ATTRIBUTES, a.name))));
    if (base.kind === "unknown") {
      if (named || ownRoutes) reader.limit(types[0]!.file, types[0]!.at, `declares ${name}, which derives from ${base.name}, a class not among the files read: the routes, area and actions it may give are not read`);
      continue;
    }
    if (!named && !marked) continue;
    const used = [...chain.flat().flatMap((t) => [...t.attributes, ...t.methods.flatMap((m) => m.attributes)])].find((a) => foreign.has(a.name));
    if (used) {
      reader.limit(types[0]!.file, types[0]!.at, `declares ${name}, which uses [${used.name}], an attribute the files declare themselves; its routes are not read`);
      continue;
    }
    const ctxOf = (t: TypeDecl): Ctx => ({ model, file: t.file, type: t, region: [0, 0], params: new Map(), stack: [] });
    // The routes of the first class up the chain that has route attributes (`CreateControllerModel`).
    let routes: Selector[] = [{ methods: [] }];
    let unread: string | undefined;
    for (const level of chain) {
      const providers = level.flatMap((t) => {
        const p = routeProviders(ctxOf(t), t.attributes);
        if (typeof p === "string") unread ??= p;
        return typeof p === "string" ? [] : p;
      });
      if (providers.length || unread) {
        routes = selectors(providers);
        break;
      }
    }
    if (unread) {
      reader.limit(types[0]!.file, types[0]!.at, `declares ${name}, whose ${unread}; its routes are not read`);
      continue;
    }
    let area: string | undefined;
    for (const level of chain) {
      const a = attrs(level).find((x) => x.name === "Area");
      if (!a) continue;
      const t = level.find((x) => x.attributes.includes(a))!;
      const arg = a.args[0];
      area = arg ? stringOf(ctxOf(t), t.file.tokens, arg.start, arg.end, arg.start, t.file) : undefined;
      if (area === undefined) unread = `[Area] at ${t.file.file}:${lineAt(t.file, a.at)} names an area atlas does not read`;
      break;
    }
    if (unread) {
      reader.limit(types[0]!.file, types[0]!.at, `declares ${name}, whose ${unread}; its routes are not read`);
      continue;
    }
    const disposable = base.kind === "mvc" && chain.flatMap((l) => l.flatMap((t) => t.bases)).includes("Controller");
    const actions: Action[] = [];
    const seen = new Set<string>();
    for (const level of chain) {
      for (const t of level) {
        for (const m of t.methods) {
          const signature = `${m.name}/${m.params.length}`;
          if (seen.has(signature)) continue;
          seen.add(signature);
          if (!m.modifiers.has("public") || m.modifiers.has("static") || m.modifiers.has("abstract") || m.generic || m.explicit) continue;
          if (m.modifiers.has("override") && ["ToString", "Equals", "GetHashCode"].includes(m.name)) continue;
          if (m.name === "Dispose" && m.params.length === 0 && (disposable || chain.some((l) => l.some((x) => x.bases.includes("IDisposable"))))) continue;
          // [NonAction] and the route attributes of the nearest declaration up the chain that has any.
          const overridden = chain.flatMap((l) => l.flatMap((x) => x.methods.filter((b) => b.name === m.name && b.params.length === m.params.length)));
          if (overridden.some((b) => b.attributes.some((a) => a.name === "NonAction"))) continue;
          const declaring = overridden.find((b) => b.attributes.some((a) => Object.hasOwn(ROUTE_ATTRIBUTES, a.name))) ?? m;
          const providers = routeProviders(ctxOf(declaring.owner), declaring.attributes);
          if (typeof providers === "string") {
            reader.limit(m.owner.file, m.at, `declares the action ${name}.${m.name}, whose ${providers}; its routes are not read`);
            continue;
          }
          const actionName = m.attributes.find((a) => a.name === "ActionName");
          let actionText = suppressAsync && m.name.endsWith("Async") ? m.name.slice(0, -"Async".length) : m.name;
          if (actionName) {
            const a = actionName.args[0];
            const v = a ? stringOf(ctxOf(m.owner), m.owner.file.tokens, a.start, a.end, a.start, m.owner.file) : undefined;
            if (v === undefined) {
              reader.limit(m.owner.file, m.at, `declares the action ${name}.${m.name}, whose [ActionName] atlas does not read; its routes are not read`);
              continue;
            }
            actionText = v;
          }
          actions.push({ method: m, name: actionText, selectors: selectors(providers) });
        }
      }
    }
    out.push({ name: name.toLowerCase().endsWith("controller") ? name.slice(0, -"Controller".length) : name, types, ...(area !== undefined ? { area } : {}), routes, actions });
  }
  return out;
}

/** A route's segments and what it is matched by, before it becomes surfaces. */
interface Built {
  segments: PatternSegment[];
  methods: string[];
  at: Place;
  order: number | undefined;
  convention?: string;
}

/** The segments of each template in turn, or why ASP.NET Core rejects one. */
function segmentsOf(templates: string[]): PatternSegment[] | string {
  const out: PatternSegment[] = [];
  for (const t of templates) {
    const p = parsePattern(t);
    if ("error" in p) return `${JSON.stringify(t)} ${p.error}`;
    out.push(...p.segments);
  }
  return out;
}

/** The surfaces of a route: one for each path it serves and each method it takes. */
function surfacesOf(component: string, b: Built, said: (at: Place, why: string) => void): Surface[] {
  // Each segment with an optional last part doubles the paths: past a few, the template is not one to spell out.
  if (b.segments.filter((s) => s.length > 2 && "parameter" in s[s.length - 1]! && (s[s.length - 1] as { parameter: { optional: boolean } }).parameter.optional).length > 6) {
    said(b.at, "maps a route with more than six segments of an optional last part; it is not read");
    return [];
  }
  const names = new Set<string>();
  for (const seg of b.segments) {
    for (const p of seg) {
      if ("literal" in p) {
        // atlas writes a parameter in braces and a wildcard as `*`: a literal with them would read as one.
        if (/[{}*]/.test(p.literal)) {
          said(b.at, `maps a route whose literal ${JSON.stringify(p.literal)} atlas cannot write; it is not read`);
          return [];
        }
        continue;
      }
      const lower = p.parameter.name.toLowerCase();
      if (names.has(lower)) {
        said(b.at, `maps a route that repeats the parameter ${p.parameter.name}, which ASP.NET Core rejects; it is not read`);
        return [];
      }
      names.add(lower);
    }
  }
  const patterns: Record<string, string> = Object.create(null) as Record<string, string>;
  const unchecked = new Set<string>();
  for (const seg of b.segments) {
    for (const p of seg) {
      if (!("parameter" in p) || p.parameter.required) continue;
      const pattern = constraintPattern(p.parameter.constraints);
      if (pattern === undefined || (p.parameter.catchAll && pattern !== null)) unchecked.add(p.parameter.name);
      else if (pattern !== null) patterns[p.parameter.name] = pattern;
    }
  }
  const rank = b.order === undefined ? undefined : [b.order, ...precedence(b.segments)];
  const out: Surface[] = [];
  for (const { path, narrowed } of servedPaths(b.segments)) {
    const present = new Set([...path.matchAll(/\{\*?([^{}]+)\}/g)].map((m) => m[1]!));
    const loose = [...unchecked].filter((k) => present.has(k));
    // Entries, not assignment: a parameter may be named `__proto__`.
    const entries = Object.entries(patterns)
      .filter(([k]) => present.has(k))
      .map(([k, v]): [string, string] => {
        const narrower = Object.hasOwn(narrowed, k) ? narrowed[k] : null;
        return [k, narrower ? `(?=(?:${v})$)(?:${narrower})` : v];
      });
    for (const [k, narrower] of Object.entries(narrowed)) {
      if (narrower === undefined) {
        if (!loose.includes(k)) loose.push(k);
      } else if (!Object.hasOwn(patterns, k)) entries.push([k, narrower]);
    }
    const own = Object.fromEntries(entries);
    const dispatch: Dispatch = { ...(rank ? { picks: "precedence" as const, rank } : {}), slashes: "ignored", caseless: true, ...(loose.length ? { unchecked: loose } : {}) };
    for (const method of b.methods) {
      out.push({
        id: surfaceId({ component, method, path }),
        component,
        method,
        path,
        at: b.at,
        evidence: "static",
        ...(Object.keys(own).length ? { patterns: own } : {}),
        ...(b.convention ? { implicit: true, convention: b.convention } : {}),
        dispatch,
      });
    }
  }
  return out;
}

/** The routes of the controllers mapped on each source: attribute routes, and the conventional routes of the rest. */
function controllerRoutes(list: Controller[], source: ControllerSource, prefix: string[], said: (at: Place, why: string) => void): Built[] {
  const out: Built[] = [];
  const prefixSegments = segmentsOf(prefix);
  if (typeof prefixSegments === "string") {
    said(source.at, `maps controllers under the prefix ${prefixSegments}; they are not read`);
    return out;
  }
  const anyArea = list.some((c) => c.area !== undefined);
  {
    for (const c of list) {
      for (const action of c.actions) {
        const place: Place = { file: action.method.owner.file.file, line: lineAt(action.method.owner.file, action.method.at) };
        // Each action's route values: its controller and action, and its area, or none where another has one.
        const required = new Map<string, string | null>([
          ["action", action.name],
          ["controller", c.name],
        ]);
        if (c.area !== undefined) required.set("area", c.area);
        else if (anyArea) required.set("area", null);
        const tokens = new Map<string, string>([
          ["action", action.name],
          ["controller", c.name],
          ...(c.area !== undefined ? [["area", c.area] as [string, string]] : []),
        ]);
        for (const selector of action.selectors) {
          const flattened = isOverride(selector.template)
            ? [{ template: combine(undefined, selector.template), order: selector.order }]
            : c.routes.some((r) => r.template !== undefined || r.order !== undefined)
              ? c.routes.map((r) => ({ template: combine(r.template, selector.template), order: selector.order ?? r.order }))
              : [{ template: combine(undefined, selector.template), order: selector.order }];
          const methods = selector.methods.length ? selector.methods : ["*"];
          for (const route of flattened) {
            if (route.template === undefined) {
              out.push(...conventional(source.conventional, required, methods, place, prefixSegments, said));
              continue;
            }
            const replaced = replaceTokens(route.template, tokens);
            if (typeof replaced !== "string") {
              said(place, `gives ${c.name}.${action.method.name} the route ${JSON.stringify(route.template)}, which ${replaced.error}; it is not read`);
              continue;
            }
            const segments = segmentsOf([replaced]);
            if (typeof segments === "string") {
              said(place, `gives ${c.name}.${action.method.name} the route ${segments}; it is not read`);
              continue;
            }
            // Route values with no parameter of their name become defaults (`ResolveDefaultsAndRequiredValues`).
            const named = new Set(segments.flatMap((s) => s.flatMap((p) => ("parameter" in p ? [p.parameter.name.toLowerCase()] : []))));
            const values = new Map([...required].filter(([k, v]) => v && named.has(k)));
            const substituted = substitute(segments, new Map(), values);
            if (!substituted) {
              said(place, `gives ${c.name}.${action.method.name} the route ${JSON.stringify(replaced)}, whose ${substituted === undefined ? "constraints on its route values atlas does not read" : "route values it cannot take"}; it is not read`);
              continue;
            }
            out.push({ segments: [...prefixSegments, ...substituted], methods, at: place, order: route.order ?? 0 });
          }
        }
      }
    }
  }
  return out;
}

/** The conventional routes that reach an action with these route values (`ActionEndpointFactory.AddEndpoints`). */
function conventional(routes: ConventionalRoute[], required: Map<string, string | null>, methods: string[], at: Place, prefix: PatternSegment[], said: (at: Place, why: string) => void): Built[] {
  const out: Built[] = [];
  for (const route of routes) {
    const parsed = segmentsOf([route.pattern]);
    if (typeof parsed === "string") {
      said(route.at, `maps the conventional route ${parsed}; it is not read`);
      continue;
    }
    // Inline defaults and the defaults argument; `MapAreaControllerRoute` adds its area as a default it requires.
    const defaults = new Map(route.defaults);
    for (const p of parsed.flatMap((s) => s)) if ("parameter" in p && p.parameter.default !== undefined) defaults.set(p.parameter.name, p.parameter.default);
    if (route.area !== undefined) {
      if ((required.get("area") ?? "").toLowerCase() !== route.area.toLowerCase()) continue;
      defaults.set("area", route.area);
    }
    const segments = parsed.map((s) =>
      s.map((p) => {
        if (!("parameter" in p) || p.parameter.default !== undefined) return p;
        const d = [...route.defaults].find(([k]) => k.toLowerCase() === p.parameter.name.toLowerCase())?.[1];
        return d === undefined ? p : { parameter: { ...p.parameter, default: d } };
      }),
    );
    const substituted = substitute(segments, defaults, required);
    if (substituted === undefined) {
      said(route.at, `maps the conventional route ${JSON.stringify(route.pattern)}, whose constraints on route values atlas does not read; it is not read`);
      continue;
    }
    if (!substituted) continue;
    out.push({ segments: [...prefix, ...substituted], methods, at, order: route.order });
  }
  return out;
}

/** The directory of the project (`*.csproj`) a file belongs to: the nearest above it. */
function projectOf(listed: string[], file: string): string | undefined {
  const projects = new Set(listed.filter((f) => f.endsWith(".csproj")).map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "")));
  for (let dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""; ; dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "") {
    if (projects.has(dir)) return dir;
    if (dir === "") return undefined;
  }
}

/**
 * The routes of ASP.NET Core applications in the C# files of a route entry: what the program's top-level statements,
 * its `Main` and the `Configure` of a `UseStartup<T>` class map, through the methods of the files they call.
 */
export function aspnetcoreRoutes(source: Source, spec: RouteSource, files: string[], exclude: string[], limits: string[], spans?: Spans): Surface[] {
  const texts = new Map(files.filter((f) => f.endsWith(".cs")).map((f) => [f, source.read(f) ?? ""]));
  if (!texts.size) return [];
  const model = csharpModel(texts);
  const reader = new Reader(model, spec.component, spans);
  const base = (f: CsFile, region: [number, number]): Ctx => ({ model, file: f, region, params: new Map(), stack: [] });
  for (const f of model.files) if (f.topLevel) reader.walk(base(f, f.topLevel));
  for (const t of model.types) for (const m of t.methods) if (m.name === "Main" && m.modifiers.has("static") && m.body) reader.walk(enter(base(t.file, m.body), m, new Map()));
  // `UseStartup<T>()`: the host calls T's Configure with the application (ASP.NET Core's Startup convention).
  const startups = new Set<string>();
  for (const f of model.files) {
    f.tokens.forEach((t, i) => {
      if (isWord(t, "UseStartup") && isP(tok(f, i + 1), "<") && isWord(tok(f, i + 2)) && isP(tok(f, i + 3), ">")) startups.add(tok(f, i + 2)!.text);
    });
  }
  for (const name of startups) {
    for (const t of model.typesByName.get(name) ?? []) {
      for (const m of t.methods) {
        if (!/^Configure(?!Services|Container)\w*$/.test(m.name) || !m.body) continue;
        const params = new Map<string, Value>(m.params.filter((p) => BUILDER_TYPES.test(p.type)).map((p) => [p.name, { kind: "builder", prefix: [] }]));
        if (params.size) reader.walk(enter(base(t.file, m.body), m, params));
      }
    }
  }
  // A method that maps routes on what its callers pass, and that no call read reaches with a builder.
  for (const t of model.types) {
    for (const m of t.methods) {
      if (!m.body || reader.walked.has(methodKey(m))) continue;
      const f = t.file;
      for (let n = m.body[0]; n < m.body[1]; n++) {
        const name = tok(f, n)?.text ?? "";
        if (!isWord(tok(f, n)) || !isP(tok(f, n - 1), ".") || !isP(tok(f, n + 1), "(")) continue;
        if (!Object.hasOwn(VERBS, name) && !["MapMethods", "MapGroup", "MapControllers", "MapControllerRoute", "MapFallback"].includes(name)) continue;
        reader.limit(f, m.at, `declares ${t.name}.${m.name}, which maps routes on a builder no call atlas reads passes it; they are not read`);
        break;
      }
    }
  }
  // A route attribute's template is the route's, not a request.
  for (const t of model.types) {
    for (const a of [...t.attributes, ...t.methods.flatMap((m) => m.attributes)]) {
      if (!Object.hasOwn(ROUTE_ATTRIBUTES, a.name)) continue;
      for (const x of a.args) spans?.add(t.file.file, t.file.tokens[x.start]!.start, t.file.tokens[x.end - 1]!.end);
    }
  }
  const said = (at: Place, why: string) => reader.said.push(`routes ${spec.component}: ${at.file}:${at.line} ${why}`);
  const prefixed = (p: string[]) => (spec.prefix ? [spec.prefix, ...p] : p);
  const out: Surface[] = [];
  for (const m of reader.mapped) {
    const segments = segmentsOf(prefixed([...m.prefix, m.pattern]));
    if (typeof segments === "string") {
      said(m.at, `maps the route ${segments}; it is not read`);
      continue;
    }
    out.push(...surfacesOf(spec.component, { segments, methods: m.methods, at: m.at, order: m.order, ...(m.convention ? { convention: m.convention } : {}) }, said));
  }
  if (reader.sources.size) {
    const suppressAsync = !model.files.some((f) => f.tokens.some((t, i) => isWord(t, "SuppressAsyncSuffixInActionNames") && isP(tok(f, i + 1), "=") && isWord(tok(f, i + 2), "false")));
    const transformer = model.files.find((f) => f.tokens.some((t) => isWord(t, "RouteTokenTransformerConvention")));
    const list = transformer ? [] : controllers(model, reader, suppressAsync);
    if (transformer) reader.said.push(`routes ${spec.component}: ${transformer.file} adds a RouteTokenTransformerConvention, which changes the [controller] and [action] values; the controllers' routes are not read`);
    for (const source of reader.sources.values()) {
      for (const b of controllerRoutes(list, source, prefixed(source.prefix), said)) out.push(...surfacesOf(spec.component, b, said));
    }
  } else {
    const declared = controllers(model, new Reader(model, spec.component, undefined), true).filter((c) => c.actions.length);
    if (declared.length) reader.said.push(`routes ${spec.component}: no MapControllers or MapControllerRoute call atlas reads maps the controllers (${declared.map((c) => `${c.name}Controller`).join(", ")}); their routes are not read`);
  }
  out.push(...staticRoutes(source, spec, model, reader, exclude, prefixed));
  limits.push(...reader.said);
  return out;
}

/** The files of `wwwroot` that `UseStaticFiles` and `MapStaticAssets` serve, to GET and HEAD. */
function staticRoutes(source: Source, spec: RouteSource, model: Model, reader: Reader, exclude: string[], prefixed: (p: string[]) => string[]): Surface[] {
  if (!reader.statics.length) return [];
  const listed = source.list();
  const skipped = matcher(exclude);
  const out: Surface[] = [];
  // Where the code moves the web root, its files are elsewhere.
  const moved = model.files.find((f) => f.tokens.some((t) => isWord(t, "WebRootPath") || isWord(t, "UseWebRoot")));
  for (const s of reader.statics) {
    const where = `${s.at.file}:${s.at.line}`;
    if (moved) {
      reader.said.push(`routes ${spec.component}: ${where} calls ${s.kind}, and ${moved.file} sets the web root; the files it serves are not read`);
      continue;
    }
    const project = projectOf(listed, s.at.file);
    if (project === undefined) {
      reader.said.push(`routes ${spec.component}: ${where} calls ${s.kind}, and no project file (.csproj) above it says where its wwwroot is; the files it serves are not read`);
      continue;
    }
    const root = `${project ? `${project}/` : ""}wwwroot/`;
    const prefix = segmentsOf(prefixed(s.prefix));
    if (typeof prefix === "string") continue;
    for (const file of listed) {
      if (!file.startsWith(root) || skipped(file) || /[{}*?]/.test(file)) continue;
      const path = `/${file.slice(root.length)}`;
      const segments = [...prefix, ...path.split("/").filter(Boolean).map((l) => [{ literal: l }])];
      if (s.kind === "MapStaticAssets") out.push(...surfacesOf(spec.component, { segments, methods: ["GET", "HEAD"], at: { file, line: 1 }, order: 0, convention: "aspnetcore MapStaticAssets" }, () => {}));
      else {
        for (const method of ["GET", "HEAD"]) {
          out.push({ id: surfaceId({ component: spec.component, method, path }), component: spec.component, method, path, at: { file, line: 1 }, evidence: "static", implicit: true, convention: "aspnetcore UseStaticFiles" });
        }
      }
    }
    if (s.kind === "MapStaticAssets") {
      reader.said.push(`routes ${spec.component}: ${where} calls MapStaticAssets, which also serves each file under the fingerprinted name and in the compressed forms the build gives it, and the assets of referenced projects; those are not read`);
    }
  }
  return out;
}
