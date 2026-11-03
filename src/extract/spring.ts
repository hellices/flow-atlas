import type { RouteSource } from "../config.js";
import type { Surface } from "../model.js";
import { surfaceId } from "../model.js";
import { joinRoute, routeTemplate } from "../paths.js";
import { lineOf } from "../source.js";
import { literalEnd, withoutComments } from "./calls.js";

const SHORTCUTS: Record<string, string> = { GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT", DeleteMapping: "DELETE", PatchMapping: "PATCH" };
const MAPPING = /@(?:[\w.]*\.)?(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\b/g;
// A type's name, plain or a Kotlin backtick identifier (`Foo Controller`).
const TYPE = /\b(?:class|interface|object|record)\s+(?:[A-Za-z_]\w*|`[^`\n]+`)/g;
const REQUEST_METHODS = /\b(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE)\b/g;

/** The views a handler renders, by route, with the file of the handler so its application's templates can be found. */
export type Views = Map<string, { file: string; names: string[] }>;

/**
 * Java or Kotlin code with the contents of every string and character literal blanked (quotes, newlines and offsets
 * kept), so annotations, braces and keywords are searched in code only. Values are read back from the unmasked text.
 */
function maskStrings(file: string, code: string): string {
  const out = code.split("");
  let i = 0;
  while (i < code.length) {
    const quote = code.startsWith('"""', i) ? '"""' : code[i] === '"' || code[i] === "'" ? code[i]! : undefined;
    if (!quote) {
      i++;
      continue;
    }
    const end = literalEnd(code, i, quote, file);
    const close = code.startsWith(quote, end - quote.length) ? end - quote.length : end;
    for (let k = i + quote.length; k < close; k++) if (out[k] !== "\n") out[k] = " ";
    i = end;
  }
  return out.join("");
}

/** Where the `(`, `{` or `[` at `open` closes, in masked code. */
function closing(masked: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i]!;
    if (c === "(" || c === "{" || c === "[") depth++;
    else if ((c === ")" || c === "}" || c === "]") && --depth === 0) return i;
  }
  return undefined;
}

/** Where the declaration holding `at` begins: after the last `;`, `{` or `}` outside parentheses before it. */
function declarationStart(masked: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = masked[i]!;
    if (c === ")") depth++;
    else if (c === "(") depth--;
    else if (depth === 0 && (c === ";" || c === "{" || c === "}")) return i + 1;
  }
  return 0;
}

/**
 * Where the run of annotations that holds the one at `at` begins: annotations written one after another, with only
 * spaces between, belong to one declaration. Members in Kotlin need no `;`, so the previous member's text is not a
 * boundary to search back to.
 */
function annotationsStart(masked: string, at: number): number {
  const spans: Array<{ start: number; end: number }> = [];
  for (const a of masked.matchAll(/@[\w.]+/g)) {
    const start = a.index ?? 0;
    let end = start + a[0].length;
    let j = end;
    while (/\s/.test(masked[j] ?? "")) j++;
    if (masked[j] === "(") end = (closing(masked, j) ?? j) + 1;
    spans.push({ start, end });
  }
  let begin = at;
  for (;;) {
    const previous = spans.filter((sp) => sp.end <= begin && !masked.slice(sp.end, begin).trim()).pop();
    if (!previous) return begin;
    begin = previous.start;
  }
}

/**
 * String literals of a value: `"a"`, `{"a", "b"}`, `["a"]`, `arrayOf("a")`, or a one-line Kotlin raw string
 * `"""a"""`, whose run of closing quotes ends at its last three; undefined when anything else is in it. A literal over
 * several lines (a Java text block) is not read, since its indentation is stripped.
 */
function literals(value: string): string[] | undefined {
  const out: string[] = [];
  let multiline = false;
  const rest = value.replace(/"""([\s\S]*?"*)"""(?!")|"((?:[^"\\\n]|\\.)*)"/g, (_, raw: string | undefined, s: string | undefined) => {
    if (raw?.includes("\n")) multiline = true;
    out.push(raw ?? s!);
    return "";
  });
  if (multiline) return undefined;
  return /^[\s{}[\],]*$/.test(rest.replace(/\barrayOf\s*\(/, "").replace(/\)\s*$/, "")) ? out : undefined;
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

/**
 * The methods a `@RequestMapping` names: none when it states no `method`, the `RequestMethod` values it lists, or
 * undefined when its `method` is an expression this reading cannot resolve.
 */
function requestMethods(args: string | undefined): string[] | undefined {
  const value = args ? attributes(args).named.get("method") : undefined;
  if (!value) return [];
  const methods = [...value.matchAll(REQUEST_METHODS)].map((m) => m[1]!);
  return methods.length ? [...new Set(methods)] : undefined;
}

/**
 * A Spring path pattern as an OpenAPI-style template: `{id}` and `{id:\\d+}` are both `{id}`. A catch-all keeps its
 * form (`{*rest}`, `**`), which matching takes as the rest of the path.
 */
const springTemplate = (path: string): string =>
  routeTemplate(path.replace(/\{(\*?[A-Za-z_]\w*)(?::[^{}]*(?:\{[^{}]*\}[^{}]*)*)?\}/g, "{$1}"));

/**
 * Where the parameter list of the method a mapping annotates opens: past the annotations that follow the mapping
 * (`@ResponseBody`, `@ResponseStatus(HttpStatus.OK)`), whatever their order.
 */
function parametersAt(masked: string, from: number): number | undefined {
  let i = from;
  for (;;) {
    while (/\s/.test(masked[i] ?? "")) i++;
    const annotation = /^@[\w.]+/.exec(masked.slice(i));
    if (!annotation) break;
    i += annotation[0].length;
    let j = i;
    while (/\s/.test(masked[j] ?? "")) j++;
    if (masked[j] === "(") {
      const close = closing(masked, j);
      if (close === undefined) return undefined;
      i = close + 1;
    }
  }
  const open = masked.indexOf("(", i);
  return open < 0 ? undefined : open;
}

/**
 * Where a Kotlin expression body that starts at `from` ends: at a line break outside brackets, unless the next line
 * goes on with the expression (`.call()`, `?:`, an operator, `else`).
 */
function expressionEnd(masked: string, from: number): number {
  let depth = 0;
  let i = from;
  while (/\s/.test(masked[i] ?? "")) i++;
  for (; i < masked.length; i++) {
    const c = masked[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (c === "\n" && depth === 0) {
      const line = masked.slice(masked.lastIndexOf("\n", i - 1) + 1, i).trim();
      const next = /^\s*(\S{1,4})/.exec(masked.slice(i + 1))?.[1] ?? "";
      // The expression goes on when this line leaves it open (`if (x)`, `=`, `->`, `else`, an operator) or the next
      // line continues it (`.call()`, `?:`, an operator, `else`).
      const open = !line || /(?:\b(?:if|while)\s*\(.*\)|[=,+\-*/(]|->|&&|\|\||\?:|\belse)$/.test(line);
      if (!open && !/^(\?\.|\?:|\.|\+|-|\*|\/|&&|\|\||else\b)/.test(next)) return i;
    }
  }
  return masked.length;
}

/**
 * The body of the method a mapping annotates, after its parameter list: `{ ... }`, or a Kotlin `= expression`; as
 * written and with its strings masked.
 */
function methodBody(code: string, masked: string, open: number): { body: string; masked: string } | undefined {
  const close = closing(masked, open);
  if (close === undefined) return undefined;
  const brace = masked.slice(close + 1).search(/[{;=]/);
  if (brace < 0) return undefined;
  const start = close + 1 + brace;
  let end: number | undefined;
  if (masked[start] === "=") end = expressionEnd(masked, start + 1);
  else if (masked[start] === "{") end = (closing(masked, start) ?? -2) + 1;
  if (end === undefined || end < 0) return undefined;
  return { body: code.slice(start, end), masked: masked.slice(start, end) };
}

/**
 * View names a handler body renders: `ModelAndView("x")` and `setViewName("x")` always; when the handler writes no
 * response body, also `return "x"` or a Kotlin expression body `= "x"`. Redirects and forwards are not views.
 */
function viewNames({ body, masked }: { body: string; masked: string }, strings: boolean): string[] {
  const explicit = /(?:ModelAndView\s*\(\s*|setViewName\s*\(\s*)"([^"\\:]+)"/g;
  // In a Kotlin expression body, a branch's value is a result too: `= if (x) "a" else "b"`, `when { c -> "a" }`.
  const returned = !body.trimStart().startsWith("{")
    ? /(?:\breturn\s+|=\s*|\)\s*|\belse\s+|->\s*)"([^"\\:]+)"/g
    : /\breturn\s+"([^"\\:]+)"/g;
  // A match that starts inside a string literal (masked there) is text, not a call or a result.
  const names = [...body.matchAll(explicit), ...(strings ? body.matchAll(returned) : [])]
    .filter((m) => masked[m.index ?? 0] === body[m.index ?? 0])
    .map((m) => m[1]!);
  return [...new Set(names.filter((n) => /^[\w./-]+$/.test(n)))];
}

interface TypeScope {
  /** Where the body's `{` and `}` are. */
  start: number;
  end: number;
  /** The class-level mapping's paths and methods; paths undefined when they are built in code. */
  paths: string[] | undefined;
  methods: string[] | undefined;
  /** `@RestController` or `@ResponseBody` on the type: handlers write their return value as the response. */
  responseBody: boolean;
}

/**
 * Spring MVC routes in Java or Kotlin: `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`,
 * `@PatchMapping` and `@RequestMapping` on methods, combined with the `@RequestMapping` on the type that holds them
 * (paths joined, methods united as Spring does), and the login and logout endpoints Spring Security configures. A path
 * or method the file does not spell out (a constant, an expression) is unknown, and no route is registered for it.
 * `views` collects, per route, the view names its handler renders.
 */
export function routesFromSpring(file: string, text: string, spec: RouteSource, views?: Views): Surface[] {
  const code = withoutComments(file, text);
  const masked = maskStrings(file, code);
  const mappings = [...masked.matchAll(MAPPING)].map((m) => {
    const at = m.index ?? 0;
    let open = at + m[0].length;
    while (/\s/.test(masked[open] ?? "")) open++;
    const close = masked[open] === "(" ? closing(masked, open) : undefined;
    return { at, kind: m[1]!, args: close === undefined ? undefined : code.slice(open + 1, close), end: close === undefined ? at + m[0].length : close + 1 };
  });

  const types: TypeScope[] = [];
  const typeLevel = new Set<number>();
  for (const t of masked.matchAll(TYPE)) {
    const at = t.index ?? 0;
    const header = declarationStart(masked, at);
    // The body is the first `{` after the name outside parentheses (a constructor's parameters come first in Kotlin).
    let i = at + t[0].length;
    let depth = 0;
    for (; i < masked.length; i++) {
      const c = masked[i]!;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (depth === 0 && (c === "{" || c === ";")) break;
    }
    const end = masked[i] === "{" ? closing(masked, i) : undefined;
    if (end === undefined) continue;
    const own = mappings.find((m) => m.kind === "RequestMapping" && m.at >= header && m.at < at);
    if (own) typeLevel.add(own.at);
    const annotations = code.slice(header, at);
    types.push({
      start: i,
      end,
      paths: own ? mappingPaths(own.args) : [""],
      methods: own ? requestMethods(own.args) : [],
      responseBody: /@(?:[\w.]*\.)?(?:RestController|ResponseBody)\b/.test(annotations),
    });
  }

  const out: Surface[] = [];
  for (const m of mappings) {
    if (typeLevel.has(m.at)) continue;
    // The innermost type whose body holds the handler; a nested type closed before it does not count.
    const owner = types.filter((t) => t.start < m.at && m.at < t.end).sort((a, b) => b.start - a.start)[0];
    const bases = owner ? owner.paths : [""];
    const paths = mappingPaths(m.args);
    const own = m.kind === "RequestMapping" ? requestMethods(m.args) : [SHORTCUTS[m.kind]!];
    const inherited = owner ? owner.methods : [];
    if (!bases || !paths || !own || !inherited) continue;
    const united = [...new Set([...inherited, ...own])];
    const methods = united.length ? united : ["*"];
    const open = parametersAt(masked, m.end);
    // Every annotation on the method, before or after the mapping.
    const signature = code.slice(annotationsStart(masked, m.at), open ?? m.end);
    const responseBody = (owner?.responseBody ?? false) || /@(?:[\w.]*\.)?ResponseBody\b/.test(signature);
    const body = views && open !== undefined ? methodBody(code, masked, open) : undefined;
    const rendered = body ? viewNames(body, !responseBody) : [];
    for (const base of bases) {
      for (const path of paths) {
        const full = springTemplate(joinRoute(base, path));
        for (const method of methods) {
          const id = surfaceId({ component: spec.component, method, path: full });
          if (rendered.length) views!.set(id, { file, names: [...new Set([...(views!.get(id)?.names ?? []), ...rendered])] });
          out.push({ id, component: spec.component, method, path: full, at: { file, line: lineOf(text, m.at) }, evidence: "text" });
        }
      }
    }
  }
  out.push(...securityRoutes(file, text, code, masked, spec));
  return out;
}

/**
 * What a configurer call sets, in its configuration: the literal it passes, `null` when it is called with something
 * else (a constant, an expression), or undefined when it is not called.
 */
function setting(code: string, masked: string, call: string): string | null | undefined {
  // A builder keeps the last value a setter was given.
  const m = [...masked.matchAll(new RegExp(`\\.${call}\\s*\\(`, "g"))].pop();
  if (!m) return undefined;
  const open = (m.index ?? 0) + m[0].length - 1;
  const close = closing(masked, open);
  const arg = close === undefined ? "" : code.slice(open + 1, close).trim();
  return /^"([^"\\]*)"$/.exec(arg)?.[1] ?? null;
}

/**
 * Endpoints Spring Security serves without a controller: `formLogin` takes the login form's POST at its processing URL
 * (`loginProcessingUrl`, else `loginPage`, else `/login`) and `logout` a POST at `logoutUrl`, else `/logout`. The
 * lambda form (`formLogin(f -> f.loginPage("/x"))`), the chained form (`formLogin().loginPage("/x").and()`) and
 * `withDefaults()` are read. A disabled configurer serves nothing, and a URL the file does not spell out, or a
 * customizer defined elsewhere, registers nothing.
 */
function securityRoutes(file: string, text: string, code: string, masked: string, spec: RouteSource): Surface[] {
  const out: Surface[] = [];
  // Only a file that configures HttpSecurity; `request.logout()` on a servlet request is not a configurer.
  if (!/\bHttpSecurity\b|\bSecurityFilterChain\b|\bWebSecurityConfigurerAdapter\b/.test(masked)) return out;
  const add = (path: string, index: number) => {
    const full = springTemplate(joinRoute(path));
    out.push({ id: surfaceId({ component: spec.component, method: "POST", path: full }), component: spec.component, method: "POST", path: full, at: { file, line: lineOf(text, index) }, evidence: "text" });
  };
  for (const m of masked.matchAll(/\.(formLogin|logout)\s*\(/g)) {
    const at = m.index ?? 0;
    const open = at + m[0].length - 1;
    const close = closing(masked, open);
    if (close === undefined) continue;
    let from = open + 1;
    let to = close;
    const argument = masked.slice(open + 1, close).trim();
    if (argument && !/^(?:Customizer\s*\.\s*)?withDefaults\s*\(\s*\)$/.test(argument)) {
      // A lambda is read where its parameter stays in it; a customizer held elsewhere (a variable, a method, a lambda
      // handing its parameter on) may set anything, so what it serves is unknown and nothing is registered.
      const lambda = /^(?:\(\s*)?(?:[\w<>?,.\s]+\s)?(\w+)\s*\)?\s*->/.exec(argument);
      const disabled = /^\w+\s*::\s*disable$/.test(argument);
      if (!disabled && (!lambda || new RegExp(`[(,]\\s*${lambda[1]}\\s*[,)]`).test(argument.slice(lambda[0].length)))) continue;
    }
    if (!argument) {
      // The chained form: the configuration runs from here to `.and()` or the end of the statement.
      const rest = masked.slice(close + 1);
      const stop = rest.search(/\.and\s*\(|;/);
      from = close + 1;
      to = close + 1 + (stop < 0 ? rest.length : stop);
    }
    const region = code.slice(from, to);
    const regionMasked = masked.slice(from, to);
    if (/::disable\b|\.disable\s*\(/.test(regionMasked)) continue;
    if (m[1] === "formLogin") {
      const processing = setting(region, regionMasked, "loginProcessingUrl");
      const page = setting(region, regionMasked, "loginPage");
      const url = processing !== undefined ? processing : page !== undefined ? page : "/login";
      if (url) add(url, at);
    } else {
      if (/\.logoutRequestMatcher\s*\(/.test(regionMasked)) continue;
      const url = setting(region, regionMasked, "logoutUrl");
      if (url !== null) add(url ?? "/logout", at);
    }
  }
  return out;
}
