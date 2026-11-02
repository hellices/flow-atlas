import ts from "typescript";
import type { Config, RouteSource } from "../config.js";
import type { Coverage, Surface } from "../model.js";
import { surfaceId } from "../model.js";
import { joinRoute, routeTemplate } from "../paths.js";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { lineOf, select, type Source } from "../source.js";
import { operationShape } from "./apidocs.js";
import { definitionLines, describedOperations, escapeRegExp, handlerNames } from "./openapi.js";
import { addCoverage } from "./coverage.js";
import type { Reach } from "./reach.js";

const NEST_METHODS: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Head: "HEAD",
  Options: "OPTIONS",
  Sse: "GET",
  All: "*",
};
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);

/** A property's name as written, quoted or not: `path` and `"path"` are the same key. */
function propertyName(p: ts.ObjectLiteralElementLike): string | undefined {
  const n = p.name;
  return n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) ? n.text : undefined;
}

function stringValue(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isObjectLiteralExpression(node)) {
    for (const p of node.properties) {
      if (ts.isPropertyAssignment(p) && propertyName(p) === "path") return stringValue(p.initializer);
    }
  }
  return undefined;
}

/**
 * The paths a Nest decorator gives: none written means the root; a string, a list of strings or `{ path }` are read.
 * A path the file does not spell out (a constant, an expression) is unknown, so the caller registers nothing for it.
 */
function decoratorPaths(args: readonly ts.Expression[]): string[] | undefined {
  const arg = args[0];
  if (!arg) return [""];
  if (ts.isObjectLiteralExpression(arg)) {
    const path = arg.properties.find((p) => ts.isPropertyAssignment(p) && propertyName(p) === "path") as ts.PropertyAssignment | undefined;
    if (!path) return [""];
    return decoratorPaths([path.initializer]);
  }
  if (ts.isArrayLiteralExpression(arg)) {
    const paths = arg.elements.map((e) => stringValue(e));
    return paths.length && paths.every((p) => p !== undefined) ? (paths as string[]) : undefined;
  }
  const path = stringValue(arg);
  return path === undefined ? undefined : [path];
}

function decorators(node: ts.Node): ts.Decorator[] {
  return ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];
}

function decoratorCall(d: ts.Decorator): { name: string; args: readonly ts.Expression[] } | undefined {
  if (!ts.isCallExpression(d.expression)) return undefined;
  const callee = d.expression.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  return name ? { name, args: d.expression.arguments } : undefined;
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/** An `operationId` property in an object literal among the arguments: route options, `@ApiOperation({ operationId })`. */
function operationIdIn(args: readonly ts.Expression[]): string | undefined {
  for (const arg of args) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const p of arg.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText().replace(/["']/g, "") === "operationId") {
        const v = stringValue(p.initializer);
        if (v) return v;
      }
    }
  }
  return undefined;
}

/** `executed` collects, per surface id, the `file:line` of each call its handler runs (see `Reach.from`). */
export function routesFromTypeScript(file: string, text: string, spec: RouteSource, reach?: Reach, executed?: Map<string, Set<string>>): Surface[] {
  const sf = reach?.parse(file)?.sf ?? ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const styles = new Set(spec.styles ?? []);
  const receivers = new Set(spec.receivers ?? ["app", "router", "server", "fastify"]);
  const constPattern = spec.constants ? new RegExp(spec.constants) : undefined;
  const out: Surface[] = [];
  const at = (node: ts.Node) => ({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  const add = (method: string, path: string, node: ts.Node, handler?: ts.Node, operationId?: string) => {
    const id = surfaceId({ component: spec.component, method: method.toUpperCase(), path: routeTemplate(joinRoute(path)) });
    const lines = executed ? (executed.get(id) ?? executed.set(id, new Set()).get(id)!) : undefined;
    out.push({
      id,
      component: spec.component,
      method: method.toUpperCase(),
      path: routeTemplate(joinRoute(path)),
      at: at(node),
      evidence: "static",
      ...(operationId ? { operationId } : {}),
      ...(reach && handler ? { reaches: reach.from(file, handler, lines) } : {}),
    });
  };

  const visit = (node: ts.Node): void => {
    if (styles.has("nest") && ts.isClassDeclaration(node)) {
      let bases: string[] | undefined;
      for (const d of decorators(node)) {
        const call = decoratorCall(d);
        if (call?.name === "Controller") bases = decoratorPaths(call.args);
      }
      if (bases !== undefined) {
        const className = node.name?.text;
        for (const member of node.members) {
          const explicit = decorators(member)
            .map(decoratorCall)
            .find((c) => c?.name === "ApiOperation");
          const methodName = ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) ? member.name.text : undefined;
          const operationId =
            operationIdIn(explicit?.args ?? []) ??
            (spec.operationIds === "nest-swagger" && className && methodName ? `${className}_${methodName}` : undefined);
          for (const d of decorators(member)) {
            const call = decoratorCall(d);
            const method = call ? NEST_METHODS[call.name] : undefined;
            const paths = call && method ? decoratorPaths(call.args) : undefined;
            if (!paths) continue;
            for (const base of bases) for (const path of paths) add(method!, joinRoute(base, path), member, member, operationId);
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (styles.has("express") && ts.isPropertyAccessExpression(node.expression) && name && HTTP_VERBS.has(name)) {
        const receiver = node.expression.expression;
        const path = stringValue(node.arguments[0]);
        if (ts.isIdentifier(receiver) && receivers.has(receiver.text) && path?.startsWith("/")) add(name === "all" ? "*" : name, path, node, node);
      }
      for (const c of spec.calls ?? []) {
        if (name !== c.name) continue;
        const method = stringValue(node.arguments[c.methodArg]);
        const path = stringValue(node.arguments[c.pathArg]);
        if (method && path?.startsWith("/")) add(method, path, node, node, operationIdIn(node.arguments));
      }
    }
    if (constPattern && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && constPattern.test(node.name.text)) {
      const path = stringValue(node.initializer);
      if (path?.startsWith("/")) add("GET", path, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const FASTAPI = /^[ \t]*@(\w+)\.(get|post|put|patch|delete|head|options|api_route)\(\s*/gm;
const PY_STRING = /^(?:[rRbBuUfF]{0,2})("""|'''|"|')/;

/**
 * Python source with every comment and the contents of every string literal blanked (newlines kept), so text that
 * only looks like code there is not read as code. Offsets are unchanged.
 */
export function pythonCode(text: string): string {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") out[i++] = " ";
      continue;
    }
    const m = /[A-Za-z_]/.test(text[i - 1] ?? "") ? null : PY_STRING.exec(text.slice(i, i + 5));
    if (m) {
      const quote = m[1]!;
      let j = i + m[0].length;
      while (j < text.length && !text.startsWith(quote, j)) {
        if (text[j] === "\\") j++;
        else if (quote.length === 1 && text[j] === "\n") break;
        j++;
      }
      for (let k = i + m[0].length; k < Math.min(j, text.length); k++) if (out[k] !== "\n") out[k] = " ";
      i = j + quote.length;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** The index of the `)` that closes the `(` before `from`, in code whose strings and comments are blanked. */
function closingParen(code: string, from: number): number {
  let depth = 1;
  for (let i = from; i < code.length; i++) {
    if ("([{".includes(code[i]!)) depth++;
    else if (")]}".includes(code[i]!) && --depth === 0) return i;
  }
  return code.length;
}

/**
 * The methods a FastAPI `api_route` serves: GET when `methods` is not given, the listed ones when it is a literal list,
 * tuple or set of strings; undefined when the list is built at run time, so no route is guessed.
 */
function apiRouteMethods(text: string, code: string, argsStart: number): string[] | undefined {
  const end = closingParen(code, argsStart);
  const m = /\bmethods\s*=\s*/.exec(code.slice(argsStart, end));
  if (!m) return ["GET"];
  const valueStart = argsStart + m.index + m[0].length;
  const open = code[valueStart];
  if (!open || !"[({".includes(open)) return undefined;
  const close = closingParen(code, valueStart + 1);
  const items = text.slice(valueStart + 1, close).split(",").map((x) => x.trim()).filter(Boolean);
  const methods = items.map((x) => /^[rRuU]?(["'])([A-Za-z]+)\1$/.exec(x)?.[2]?.toUpperCase());
  return methods.length && methods.every(Boolean) ? [...new Set(methods as string[])] : undefined;
}

export function routesFromPython(file: string, text: string, spec: RouteSource): Surface[] {
  const out: Surface[] = [];
  const receivers = new Set(spec.receivers ?? ["app", "router"]);
  const code = pythonCode(text);
  for (const m of code.matchAll(FASTAPI)) {
    if (!receivers.has(m[1]!)) continue;
    const argsStart = (m.index ?? 0) + m[0].length;
    // A plain, raw or unicode literal; an f-string or a name is a path the file does not spell out.
    const path = /^[rRuU]?(["'])((?:(?!\1).)+)\1/.exec(text.slice(argsStart))?.[2];
    if (!path) continue;
    const methods = m[2] === "api_route" ? apiRouteMethods(text, code, argsStart) : [m[2]!.toUpperCase()];
    for (const method of methods ?? []) {
      out.push({ id: surfaceId({ component: spec.component, method, path: joinRoute(path) }), component: spec.component, method, path: joinRoute(path), at: { file, line: lineOf(text, m.index ?? 0) }, evidence: "text" });
    }
  }
  return out;
}

/** Lines where an operationId is written as a quoted string, as code that states it explicitly does. */
function literalLines(texts: Map<string, string>, id: string): Surface["at"][] {
  const quoted = new RegExp(`(["'\`])${escapeRegExp(id)}\\1`);
  const out: Surface["at"][] = [];
  for (const [file, text] of texts) text.split("\n").forEach((l, i) => quoted.test(l) && out.push({ file, line: i + 1 }));
  return out;
}

/** Where the code defines an operation's handler: one definition by a derived name, else one quoted explicit id. */
function handlerPlace(texts: Map<string, string>, operationId: string, method: string, key: string): { at: Surface["at"]; evidence: Surface["evidence"] } | undefined {
  const hits: Surface["at"][] = [];
  for (const name of handlerNames(operationId, method, key)) {
    for (const [f, t] of texts) for (const line of definitionLines(f, t, name)) hits.push({ file: f, line });
    if (hits.length) break;
  }
  if (hits.length === 1) return { at: hits[0]!, evidence: "name" };
  const quoted = literalLines(texts, operationId);
  return quoted.length === 1 ? { at: quoted[0]!, evidence: "text" } : undefined;
}

/**
 * Surfaces from a component's OpenAPI document. An operation the code also registers keeps the code's location and
 * gains the document's operationId and place; the others are new surfaces, placed on their handler when the code gives
 * it away. `code` holds every route read so far, of every component.
 */
function documentedSurfaces(source: Source, spec: RouteSource, texts: Map<string, string>, code: Surface[], limits: string[]): Surface[] {
  const file = spec.openapi!;
  let text: string | undefined;
  if (isAbsolute(file)) {
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        limits.push(`routes ${spec.component}: the OpenAPI document ${file} could not be read (${code ?? (e as Error).message})`);
        return [];
      }
    }
  } else text = source.read(file);
  if (text === undefined) {
    limits.push(`routes ${spec.component}: the OpenAPI document ${file} is not there${isAbsolute(file) ? "" : " at this revision"}`);
    return [];
  }
  if (isAbsolute(file) && source.ref !== "WORKTREE")
    limits.push(`routes ${spec.component}: ${file} is outside the repository and is read as it is now, not at ${source.ref.slice(0, 12)}`);
  const api = describedOperations(file, text);
  if (!api) {
    limits.push(`routes ${spec.component}: ${file} is not a Swagger 2.0 or OpenAPI 3 document`);
    return [];
  }
  // Matched by method and path with parameters unnamed: the document may name them differently from the code.
  const byShape = new Map(code.filter((s) => s.component === spec.component).map((s) => [operationShape(s.method, s.path), s]));
  const out: Surface[] = [];
  for (const op of api.operations) {
    const id = surfaceId({ component: spec.component, method: op.method, path: op.path });
    const known = byShape.get(operationShape(op.method, op.path));
    if (known) {
      if (op.operationId && !known.operationId) known.operationId = op.operationId;
      if (!known.described) Object.assign(known, { described: op.at, describedPath: op.key });
      continue;
    }
    const place = op.operationId ? handlerPlace(texts, op.operationId, op.method, op.key) : undefined;
    const surface: Surface = {
      id,
      component: spec.component,
      method: op.method,
      path: op.path,
      at: place?.at ?? op.at,
      evidence: place?.evidence ?? "declared",
      ...(op.operationId ? { operationId: op.operationId } : {}),
      described: op.at,
      describedPath: op.key,
    };
    byShape.set(operationShape(op.method, op.path), surface);
    out.push(surface);
  }
  return out;
}

export function extractRoutes(
  source: Source,
  config: Config,
  reach?: Reach,
  coverage: Coverage[] = [],
  limits: string[] = [],
  executed?: Map<string, Set<string>>,
): Surface[] {
  const out: Surface[] = [];
  const codeFiles = new Map<string, Set<string>>();
  // Code first, so a document merges with the routes every entry of its component registers.
  for (const spec of config.routes) {
    const files = select(source, spec.files ?? [], config.exclude);
    const known = codeFiles.get(spec.component) ?? codeFiles.set(spec.component, new Set()).get(spec.component)!;
    const before = out.length;
    for (const file of files) {
      known.add(file);
      const text = source.read(file);
      if (text === undefined) continue;
      if (/\.(c|m)?tsx?$/.test(file) || /\.(c|m)?jsx?$/.test(file)) out.push(...routesFromTypeScript(file, text, spec, reach, executed));
      else if (file.endsWith(".py") && (spec.styles ?? []).includes("fastapi")) out.push(...routesFromPython(file, text, spec));
    }
    addCoverage(coverage, `routes ${spec.component}`, files.length, out.length - before);
  }
  for (const spec of config.routes) {
    if (!spec.openapi) continue;
    const texts = new Map([...codeFiles.get(spec.component)!].map((f) => [f, source.read(f) ?? ""]));
    const added = documentedSurfaces(source, spec, texts, out, limits);
    out.push(...added);
    addCoverage(coverage, `routes ${spec.component}`, 1, added.length);
  }
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = `${s.component}|${s.method}|${s.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
