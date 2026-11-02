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
  if (typeof url !== "string" || url.includes("{")) return "/";
  try {
    // A placeholder origin resolves absolute, network-path (`//host/v1`), root-relative and relative URLs alike.
    return decodeURI(new URL(url, "http://openapi.invalid/").pathname);
  } catch {
    return "/";
  }
}

/** The operations a Swagger 2.0 or OpenAPI 3.x document describes, each with the line it is declared at. */
export function describedOperations(file: string, text: string): DescribedApi | undefined {
  const counter = new LineCounter();
  const parsed = parseDocument(text, { lineCounter: counter });
  if (parsed.errors.length) return undefined;
  const doc = parsed.toJS() as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") return undefined;
  const version = doc.swagger !== undefined ? String(doc.swagger) : typeof doc.openapi === "string" ? doc.openapi : undefined;
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
 * name as it is.
 */
export function handlerNames(operationId: string, method: string, rawPath: string): string[] {
  const names = [operationId];
  const nest = /^[A-Za-z_$][\w$]*Controller_([A-Za-z_$][\w$]*)$/.exec(operationId);
  if (nest) names.push(nest[1]!);
  const fastapiSuffix = `${rawPath.replace(/\W/g, "_")}_${method.toLowerCase()}`;
  if (operationId.endsWith(fastapiSuffix) && operationId.length > fastapiSuffix.length) names.push(operationId.slice(0, -fastapiSuffix.length));
  return [...new Set(names)];
}

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where a function or method of this name is defined in a file: Python `def`, a TypeScript or JavaScript function or
 * class method, a Kotlin `fun`, a Java method (a return type before the name).
 */
export function definitionLines(file: string, text: string, name: string): number[] {
  const n = escapeRegExp(name);
  const modifiers = "(?:(?:public|protected|private|static|final|abstract|synchronized|async|override|suspend|open|export|default|readonly)\\s+)*";
  const patterns = file.endsWith(".py")
    ? [new RegExp(`^\\s*(?:async\\s+)?def\\s+${n}\\s*\\(`)]
    : /\.(c|m)?[jt]sx?$/.test(file)
      ? [new RegExp(`^\\s*${modifiers}function\\s*\\*?\\s*${n}\\s*\\(`), new RegExp(`^\\s*${modifiers}\\*?${n}\\s*\\([^;]*\\)\\s*(?::[^=;{]+)?\\{`)]
      : /\.kts?$/.test(file)
        ? [new RegExp(`^\\s*(?:@\\w+(?:\\([^)]*\\))?\\s+)*${modifiers}fun\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?${n}\\s*\\(`)]
        : [new RegExp(`^\\s*${modifiers}(?:<[^>]*>\\s*)?[\\w$.?]+(?:<.*>)?(?:\\[\\])*\\s+${n}\\s*\\([^;=]*$`)];
  const out: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*(?:return|if|for|while|switch|catch|new|throw)\b/.test(line)) return;
    if (patterns.some((p) => p.test(line))) out.push(i + 1);
  });
  return out;
}
