import ts from "typescript";
import type { Config, RouteSource } from "../config.js";
import type { Coverage, Surface } from "../model.js";
import { surfaceId } from "../model.js";
import { joinRoute, routeTemplate } from "../paths.js";
import { lineOf, select, type Source } from "../source.js";
import { addCoverage } from "./coverage.js";
import type { Reach } from "./reach.js";

const NEST_METHODS: Record<string, string> = { Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE", Sse: "GET", All: "*" };
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "all"]);

function stringValue(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isObjectLiteralExpression(node)) {
    for (const p of node.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText() === "path") return stringValue(p.initializer);
    }
  }
  return undefined;
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

export function routesFromTypeScript(file: string, text: string, spec: RouteSource, reach?: Reach): Surface[] {
  const sf = reach?.parse(file)?.sf ?? ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const styles = new Set(spec.styles ?? []);
  const receivers = new Set(spec.receivers ?? ["app", "router", "server", "fastify"]);
  const constPattern = spec.constants ? new RegExp(spec.constants) : undefined;
  const out: Surface[] = [];
  const at = (node: ts.Node) => ({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  const add = (method: string, path: string, node: ts.Node, handler?: ts.Node, operationId?: string) =>
    out.push({
      id: surfaceId({ component: spec.component, method: method.toUpperCase(), path: routeTemplate(joinRoute(path)) }),
      component: spec.component,
      method: method.toUpperCase(),
      path: routeTemplate(joinRoute(path)),
      at: at(node),
      evidence: "static",
      ...(operationId ? { operationId } : {}),
      ...(reach && handler ? { reaches: reach.from(file, handler) } : {}),
    });

  const visit = (node: ts.Node): void => {
    if (styles.has("nest") && ts.isClassDeclaration(node)) {
      let base: string | undefined;
      for (const d of decorators(node)) {
        const call = decoratorCall(d);
        if (call?.name === "Controller") base = stringValue(call.args[0]) ?? "";
      }
      if (base !== undefined) {
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
            if (call && method) add(method, joinRoute(base, stringValue(call.args[0]) ?? ""), member, member, operationId);
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

const FASTAPI = /@(\w+)\.(get|post|put|patch|delete|api_route)\(\s*["']([^"']+)["']/g;

export function routesFromPython(file: string, text: string, spec: RouteSource): Surface[] {
  const out: Surface[] = [];
  const receivers = new Set(spec.receivers ?? ["app", "router"]);
  for (const m of text.matchAll(FASTAPI)) {
    if (!receivers.has(m[1]!)) continue;
    const method = m[2] === "api_route" ? "*" : m[2]!.toUpperCase();
    out.push({ id: surfaceId({ component: spec.component, method, path: joinRoute(m[3]!) }), component: spec.component, method, path: joinRoute(m[3]!), at: { file, line: lineOf(text, m.index ?? 0) }, evidence: "text" });
  }
  return out;
}

export function extractRoutes(source: Source, config: Config, reach?: Reach, coverage: Coverage[] = []): Surface[] {
  const out: Surface[] = [];
  for (const spec of config.routes) {
    const files = select(source, spec.files, config.exclude);
    const before = out.length;
    for (const file of files) {
      const text = source.read(file);
      if (text === undefined) continue;
      if (/\.(c|m)?tsx?$/.test(file) || /\.(c|m)?jsx?$/.test(file)) out.push(...routesFromTypeScript(file, text, spec, reach));
      else if (file.endsWith(".py") && (spec.styles ?? []).includes("fastapi")) out.push(...routesFromPython(file, text, spec));
    }
    addCoverage(coverage, `routes ${spec.component}`, files.length, out.length - before);
  }
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = `${s.component}|${s.method}|${s.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
