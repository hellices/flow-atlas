import ts from "typescript";
import { LineCounter, parseDocument } from "yaml";
import { joinRoute, routeTemplate } from "../paths.js";
import type { Place } from "../model.js";

export interface DescribedOperation {
  method: string;
  /** The path key as the document writes it, before the base path. */
  key: string;
  /** The URL path an operation serves, as an OpenAPI template: the base path joined to the path key. */
  path: string;
  operationId?: string;
  at: Place;
}

export interface DescribedApi {
  /** `2.0` for Swagger, otherwise the document's `openapi` version. */
  version: string;
  basePath: string;
  operations: DescribedOperation[];
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/**
 * The base path an OpenAPI document puts before its paths: Swagger 2.0's `basePath`, or the path of OpenAPI 3's first
 * server URL. A server's host belongs to the environment and is dropped; server variables are left out.
 */
function basePathOf(doc: Record<string, unknown>): string {
  if (doc.swagger !== undefined) return typeof doc.basePath === "string" ? doc.basePath : "/";
  const servers = doc.servers as Array<{ url?: unknown }> | undefined;
  const url = servers?.[0]?.url;
  if (typeof url !== "string") return "/";
  // The scheme and host belong to the environment, variables in them included, and so do a query and a fragment; only
  // a variable in the path hides it.
  const path = url.replace(/^(?:[^/?#:]+:)?\/\/[^/?#]*/, "").replace(/[?#].*$/, "");
  if (path.includes("{")) return "/";
  try {
    // A placeholder origin resolves root-relative and relative paths alike.
    return decodeURI(new URL(path || "/", "http://openapi.invalid/").pathname);
  } catch {
    return "/";
  }
}

/**
 * The version of a document atlas reads: Swagger `2.0` (YAML may write it unquoted, as the number 2) or OpenAPI `3.x`.
 * Anything else, Swagger 1.x or a later OpenAPI major version included, is not read.
 */
export function supportedVersion(doc: Record<string, unknown>): string | undefined {
  if (doc.swagger !== undefined) return doc.swagger === "2.0" || doc.swagger === 2 ? "2.0" : undefined;
  return typeof doc.openapi === "string" && /^3\.\d+(\.\d+)?(-[\w.]+)?$/.test(doc.openapi) ? doc.openapi : undefined;
}

/** The operations a Swagger 2.0 or OpenAPI 3.x document describes, each with the line it is declared at. */
export function describedOperations(file: string, text: string): DescribedApi | undefined {
  const counter = new LineCounter();
  const parsed = parseDocument(text, { lineCounter: counter });
  if (parsed.errors.length) return undefined;
  const doc = parsed.toJS() as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") return undefined;
  if (Array.isArray(doc)) return undefined;
  const version = supportedVersion(doc);
  if (!version) return undefined;
  const basePath = basePathOf(doc);
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  const operations: DescribedOperation[] = [];
  for (const [key, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const method of METHODS) {
      const op = item[method] as { operationId?: unknown } | undefined;
      if (!op || typeof op !== "object") continue;
      const node = parsed.getIn(["paths", key, method], true) as { range?: [number, number, number] } | undefined;
      operations.push({
        method: method.toUpperCase(),
        key,
        path: routeTemplate(joinRoute(basePath, key)),
        ...(typeof op.operationId === "string" ? { operationId: op.operationId } : {}),
        at: { file, line: node?.range ? counter.linePos(node.range[0]).line : 1 },
      });
    }
  }
  return { version, basePath, operations };
}

/**
 * Names a handler may carry, given how common generators derive an operationId from it: the id itself, the method of
 * a NestJS `Class_method` id, and the function of a FastAPI `{function}{path}_{method}` id. springdoc uses the method
 * name as it is. When several methods share a name springdoc appends `_1`, `_2` to the later ones; such an id is not
 * traced back to its name, since an operationId may end in a number for its own reasons and nothing in the document
 * says which generator wrote it.
 *
 * A Nest id joins the class and the method with `_` (@nestjs/swagger's default `operationIdFactory`, from the
 * controller's constructor name and the method's name), and either may hold `_` itself, so every split after a
 * class-like prefix (an identifier that starts upper-case, as class names do) is a candidate: first the method of that
 * class (`Class.method`), then the method by its name alone, the longest method first. `Admin_APIController_list`
 * gives `Admin.APIController_list`, `Admin_APIController.list`, `APIController_list`, then `list`. The caller keeps
 * the first that the code defines.
 */
export function handlerNames(operationId: string, method: string, rawPath: string): string[] {
  const names = [operationId];
  if (/^[A-Z$][\w$]*$/.test(operationId)) {
    const splits: Array<[string, string]> = [];
    for (let i = operationId.indexOf("_"); i > 0; i = operationId.indexOf("_", i + 1)) {
      const member = operationId.slice(i + 1);
      if (/^[A-Za-z$][\w$]*$/.test(member)) splits.push([operationId.slice(0, i), member]);
    }
    names.push(...splits.map(([type, member]) => `${type}.${member}`), ...splits.map(([, member]) => member));
  }
  const fastapiSuffix = `${rawPath.replace(/\W/g, "_")}_${method.toLowerCase()}`;
  if (operationId.endsWith(fastapiSuffix) && operationId.length > fastapiSuffix.length) names.push(operationId.slice(0, -fastapiSuffix.length));
  return [...new Set(names)];
}

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where a definition stands: its line and, in a parsed script, the offset of its name. */
export interface Definition {
  line: number;
  offset?: number;
}

/**
 * Where a TypeScript or JavaScript file defines each function or method with a body, by name, and each method of a
 * named class also as `Class.method`: parsed, so a signature whose parameters run over several lines (as prettier
 * writes a decorated Nest handler) is found, and an overload signature or a call is not.
 */
function scriptDefinitions(file: string, text: string): Map<string, Definition[]> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = new Map<string, Definition[]>();
  const add = (name: string, at: Definition) => (out.get(name) ?? out.set(name, []).get(name)!).push(at);
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body && node.name && !ts.isComputedPropertyName(node.name)) {
      const offset = node.name.getStart(sf);
      const at = { line: sf.getLineAndCharacterOfPosition(offset).line + 1, offset };
      add(node.name.text, at);
      if (ts.isClassLike(node.parent) && node.parent.name) add(`${node.parent.name.text}.${node.name.text}`, at);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The lines `definitions` finds. */
export function definitionLines(file: string, text: string, name: string, parsed?: Map<string, Map<string, Definition[]>>): number[] {
  return definitions(file, text, name, parsed).map((d) => d.line);
}

/**
 * Where a function or method of this name is defined in a file: Python `def`, a TypeScript or JavaScript function or
 * method with a body, a Kotlin `fun`, a Java method (a return type before the name). A script's definitions keep the
 * offset of their name, as two on one line differ only by it. `parsed` keeps each script's definitions, so a file is
 * parsed once however many names are looked up in it.
 */
export function definitions(file: string, text: string, name: string, parsed?: Map<string, Map<string, Definition[]>>): Definition[] {
  if (/\.(c|m)?[jt]sx?$/.test(file)) {
    const found = parsed?.get(file) ?? scriptDefinitions(file, text);
    parsed?.set(file, found);
    return found.get(name) ?? [];
  }
  // A method of a named class is read only from a parsed script.
  if (name.includes(".")) return [];
  const n = escapeRegExp(name);
  const modifiers = "(?:(?:public|protected|private|static|final|abstract|synchronized|async|override|suspend|open|export|default|readonly)\\s+)*";
  const patterns = file.endsWith(".py")
    ? [new RegExp(`^\\s*(?:async\\s+)?def\\s+${n}\\s*\\(`)]
    : /\.kts?$/.test(file)
      ? [new RegExp(`^\\s*(?:@\\w+(?:\\([^)]*\\))?\\s+)*${modifiers}fun\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?${n}\\s*\\(`)]
      : // A Java declaration up to its opening parenthesis: annotations, modifiers, type parameters, a return type.
        [new RegExp(`^\\s*(?:@[\\w.]+(?:\\([^)]*\\))?\\s+)*${modifiers}(?:<[^>]*>\\s*)?[\\w$.]+(?:<[^()]*>)?(?:\\[\\])*\\s+${n}\\s*\\(`)];
  const out: Definition[] = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*(?:return|if|else|for|while|do|switch|case|catch|new|throw|yield|await|assert)\b/.test(line)) return;
    if (patterns.some((p) => p.test(line))) out.push({ line: i + 1 });
  });
  return out;
}
