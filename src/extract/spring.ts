import type { RouteSource } from "../config.js";
import type { Surface } from "../model.js";
import { surfaceId } from "../model.js";
import { joinRoute, routeTemplate } from "../paths.js";
import { lineOf } from "../source.js";
import { withoutComments } from "./calls.js";

const SHORTCUTS: Record<string, string> = { GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT", DeleteMapping: "DELETE", PatchMapping: "PATCH" };
const MAPPING = /@(?:[\w.]*\.)?(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\b/g;
const TYPE = /\b(?:class|interface|object)\s+[A-Za-z_]\w*/g;

/** The text between a `(` at `open` and its matching `)`, in code whose comments are blanked; strings are skipped whole. */
function argumentsAt(code: string, open: number): { text: string; end: number } | undefined {
  if (code[open] !== "(") return undefined;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"') {
      const close = code.indexOf('"', i + 1);
      i = close === -1 ? code.length : close;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if ((c === ")" || c === "}" || c === "]") && --depth === 0) return { text: code.slice(open + 1, i), end: i + 1 };
  }
  return undefined;
}

/** String literals of a value: `"a"`, `{"a", "b"}`, `["a"]`, `arrayOf("a")`; undefined when anything else is in it. */
function literals(value: string): string[] | undefined {
  const v = value.trim().replace(/^arrayOf\s*\(([\s\S]*)\)$/, "[$1]");
  const inner = /^[{[]([\s\S]*)[}\]]$/.exec(v)?.[1] ?? v;
  const items = inner.split(",").map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  for (const item of items) {
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(item);
    if (!m) return undefined;
    out.push(m[1]!);
  }
  return out;
}

/** Top-level `name = value` pairs and positional values of annotation arguments. */
function attributes(args: string): { positional?: string; named: Map<string, string> } {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quoted = false;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (c === '"' && args[i - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if ("({[".includes(c)) depth++;
    else if (")}]".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(args.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(args.slice(start));
  const named = new Map<string, string>();
  let positional: string | undefined;
  for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
    const m = /^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(part);
    if (m && !m[2]!.startsWith("=")) named.set(m[1]!, m[2]!);
    else if (positional === undefined) positional = part;
  }
  return { positional, named };
}

/** The paths a mapping names: none written means the root; a literal or a list of literals; undefined when built in code. */
function mappingPaths(args: string | undefined): string[] | undefined {
  if (args === undefined || !args.trim()) return [""];
  const { positional, named } = attributes(args);
  const value = named.get("path") ?? named.get("value") ?? positional;
  if (value === undefined) return [""];
  const paths = literals(value);
  return paths?.length ? paths : paths ? [""] : undefined;
}

/** The methods `@RequestMapping(method = ...)` names; any method when it names none. */
function requestMethods(args: string | undefined): string[] {
  const value = args ? attributes(args).named.get("method") : undefined;
  if (!value) return ["*"];
  const methods = [...value.matchAll(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g)].map((m) => m[1]!);
  return methods.length ? [...new Set(methods)] : ["*"];
}

/** `{id}` and `{id:\\d+}` are both the template `{id}`; `{*rest}` and `**` match the rest of the path. */
const springTemplate = (path: string): string =>
  routeTemplate(path.replace(/\{\*?([A-Za-z_]\w*)(?::[^{}]*(?:\{[^{}]*\}[^{}]*)*)?\}/g, "{$1}"));

/** The `{ ... }` body of the method a mapping annotates: after its parameter list, to the matching brace. */
function methodBody(code: string, from: number): string | undefined {
  const open = code.indexOf("(", from);
  const params = open < 0 ? undefined : argumentsAt(code, open);
  if (!params) return undefined;
  const brace = code.slice(params.end).search(/[{;=]/);
  if (brace < 0 || code[params.end + brace] !== "{") return code.slice(params.end, code.indexOf("\n", params.end + brace + 1));
  let depth = 0;
  const start = params.end + brace;
  for (let i = start; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"') {
      const close = code.indexOf('"', i + 1);
      i = close === -1 ? code.length : close;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return code.slice(start, i + 1);
  }
  return undefined;
}

/**
 * View names a handler body renders: `return "reviews/list"`, `ModelAndView("x")`, `setViewName("x")`, or a Kotlin
 * expression body `= "x"`. Redirects and forwards (`redirect:`, `forward:`) are not views.
 */
function viewNames(body: string): string[] {
  const expression = !body.trimStart().startsWith("{");
  const re = expression ? /(?:\breturn\s+|ModelAndView\s*\(\s*|setViewName\s*\(\s*|=\s*)"([^"\\:]+)"/g : /(?:\breturn\s+|ModelAndView\s*\(\s*|setViewName\s*\(\s*)"([^"\\:]+)"/g;
  const names = [...body.matchAll(re)].map((m) => m[1]!);
  return [...new Set(names.filter((n) => /^[\w./-]+$/.test(n)))];
}

/**
 * Spring MVC routes in Java or Kotlin: `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`,
 * `@PatchMapping` and `@RequestMapping` on methods, under the paths of a `@RequestMapping` on their class, and the login
 * and logout endpoints Spring Security configures. A path the file does not spell out (a constant, an expression) is
 * unknown, and no route is registered for it. `views` collects, per route, the view names its handler renders.
 */
export function routesFromSpring(file: string, text: string, spec: RouteSource, views?: Map<string, string[]>): Surface[] {
  const code = withoutComments(file, text);
  const types = [...code.matchAll(TYPE)].map((m) => m.index ?? 0);
  const mappings = [...code.matchAll(MAPPING)].map((m) => {
    const at = m.index ?? 0;
    let open = at + m[0].length;
    while (/\s/.test(code[open] ?? "")) open++;
    const args = argumentsAt(code, open);
    return { at, kind: m[1]!, args: args?.text, end: args?.end ?? at + m[0].length };
  });

  // A @RequestMapping that a type declaration follows, with only annotations and modifiers between, is the type's prefix.
  const prefixes = new Map<number, string[] | undefined>();
  const typeLevel = new Set<number>();
  for (const m of mappings) {
    if (m.kind !== "RequestMapping") continue;
    const next = types.find((t) => t >= m.end);
    if (next === undefined) continue;
    const between = code.slice(m.end, next);
    if (/[;{}]/.test(between.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\([^()]*\)/g, ""))) continue;
    prefixes.set(next, mappingPaths(m.args));
    typeLevel.add(m.at);
  }

  const out: Surface[] = [];
  for (const m of mappings) {
    if (typeLevel.has(m.at)) continue;
    const owner = [...types].reverse().find((t) => t < m.at);
    const bases = owner === undefined ? [""] : prefixes.has(owner) ? prefixes.get(owner) : [""];
    const paths = mappingPaths(m.args);
    if (!bases || !paths) continue;
    const methods = m.kind === "RequestMapping" ? requestMethods(m.args) : [SHORTCUTS[m.kind]!];
    const body = views ? methodBody(code, m.end) : undefined;
    const rendered = body ? viewNames(body) : [];
    for (const base of bases) {
      for (const path of paths) {
        const full = springTemplate(joinRoute(base, path));
        for (const method of methods) {
          const id = surfaceId({ component: spec.component, method, path: full });
          if (rendered.length) views!.set(id, [...new Set([...(views!.get(id) ?? []), ...rendered])]);
          out.push({
            id,
            component: spec.component,
            method,
            path: full,
            at: { file, line: lineOf(text, m.at) },
            evidence: "text",
          });
        }
      }
    }
  }
  out.push(...securityRoutes(file, text, code, spec));
  return out;
}

/** The literal a configurer call such as `.loginPage("/login")` passes, inside a stretch of code. */
const configured = (code: string, call: string): string | undefined => new RegExp(`\\.${call}\\s*\\(\\s*"([^"]+)"`).exec(code)?.[1];

/**
 * Endpoints Spring Security serves without a controller: `formLogin()` takes the login form's POST at its processing
 * URL (`loginProcessingUrl`, else `loginPage`, else `/login`), and `logout()` takes a POST at `logoutUrl`, else `/logout`.
 */
function securityRoutes(file: string, text: string, code: string, spec: RouteSource): Surface[] {
  const out: Surface[] = [];
  const add = (path: string, index: number) => {
    const full = springTemplate(joinRoute(path));
    out.push({ id: surfaceId({ component: spec.component, method: "POST", path: full }), component: spec.component, method: "POST", path: full, at: { file, line: lineOf(text, index) }, evidence: "text" });
  };
  for (const m of code.matchAll(/\.(formLogin|logout)\s*\(/g)) {
    const args = argumentsAt(code, (m.index ?? 0) + m[0].length - 1);
    const inside = args?.text ?? "";
    if (m[1] === "formLogin") add(configured(inside, "loginProcessingUrl") ?? configured(inside, "loginPage") ?? "/login", m.index ?? 0);
    else add(configured(inside, "logoutUrl") ?? "/logout", m.index ?? 0);
  }
  return out;
}
