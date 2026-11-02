import ts from "typescript";
import type { CallSource, Config } from "../config.js";
import type { Call, Coverage, Draft } from "../model.js";
import { callPath, HOLE } from "../paths.js";
import { lineOf, select, type Source } from "../source.js";
import { addCoverage } from "./coverage.js";
import { scopeOf, textScopes } from "./reach.js";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function templateText(node: ts.TemplateExpression): string {
  let s = node.head.text;
  for (const span of node.templateSpans) s += HOLE + span.literal.text;
  return s;
}

/**
 * The method a `fetch(url, init)` call uses: GET when there is no init, or an init without a `method`; the stated
 * method when it is a known one; `*` when the method or the init is built at run time.
 */
function fetchMethod(init: ts.Expression | undefined): string {
  if (!init) return "GET";
  if (!ts.isObjectLiteralExpression(init)) return "*";
  if (init.properties.some((p) => ts.isSpreadAssignment(p))) return "*";
  const method = init.properties.find((p) => p.name && p.name.getText().replace(/["']/g, "") === "method");
  if (!method) return "GET";
  return methodProperty(init) ?? "*";
}

/** The HTTP method a call site states near the string: `http.post(url)`, `request(url, "POST")`, `{ method: "POST" }`, otherwise `*`. */
function methodNear(node: ts.Node): string {
  let current: ts.Node | undefined = node;
  for (let depth = 0; current && depth < 6; depth++, current = current.parent) {
    const parent: ts.Node | undefined = current.parent;
    if (!parent) break;
    if (ts.isCallExpression(parent) && parent.arguments.includes(current as ts.Expression)) {
      const callee = parent.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
      if (VERBS.has(name.toLowerCase())) return name.toUpperCase();
      // The global fetch (also as window.fetch or globalThis.fetch) defaults to GET; the URL is its first argument.
      const global = ts.isIdentifier(callee) || (ts.isPropertyAccessExpression(callee) && /^(window|globalThis|self)$/.test(callee.expression.getText()));
      if (name === "fetch" && global && parent.arguments[0] === current) return fetchMethod(parent.arguments[1]);
      for (const arg of parent.arguments) {
        if (arg === current) continue;
        if ((ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && METHODS.has(arg.text)) return arg.text;
        const m = ts.isObjectLiteralExpression(arg) ? methodProperty(arg) : undefined;
        if (m) return m;
      }
    }
    if (ts.isObjectLiteralExpression(parent)) {
      const m = methodProperty(parent);
      if (m) return m;
    }
  }
  return "*";
}

function methodProperty(obj: ts.ObjectLiteralExpression): string | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText().replace(/["']/g, "") === "method") {
      const v = p.initializer;
      if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) {
        const method = v.text.toUpperCase();
        return METHODS.has(method) ? method : undefined;
      }
    }
  }
  return undefined;
}

export function callsFromTypeScript(file: string, text: string, spec: CallSource): Draft<Call>[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Draft<Call>[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    let raw: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) raw = node.text;
    else if (ts.isTemplateExpression(node)) raw = templateText(node);
    if (raw !== undefined) {
      const parsed = callPath(raw);
      if (parsed) {
        out.push({
          from: spec.from,
          to: spec.to,
          method: methodNear(node),
          path: parsed.path,
          based: parsed.based,
          at: { file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 },
          evidence: "static",
          scope: scopeOf(node),
        });
      }
      if (!ts.isTemplateExpression(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const STRING = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
const VERB_BEFORE = /\.(get|post|put|patch|delete|head|options)\s*\(\s*\w?$/i;
const ENUM_METHOD = /HttpMethod\.(Get|Post|Put|Patch|Delete|Head|Options)\b/g;

/** The `HttpMethod.X` nearest to a string within its statement on the line, so each of two calls on one line keeps its own. */
function enumMethodNear(line: string, start: number, end: number): string | undefined {
  const from = line.lastIndexOf(";", start) + 1;
  const stop = line.indexOf(";", end);
  const statement = line.slice(from, stop === -1 ? undefined : stop);
  let best: { method: string; distance: number } | undefined;
  for (const m of statement.matchAll(ENUM_METHOD)) {
    const at = from + (m.index ?? 0);
    const distance = at < start ? start - at : at - end;
    if (!best || distance < best.distance) best = { method: m[1]!, distance };
  }
  return best?.method;
}

/**
 * The text with every comment blanked (newlines kept, offsets unchanged) and strings left as they are: `#` comments in
 * Python, Ruby and shell, `//` and `/* *\/` in the C family (Kotlin, Java, Swift, Go, C#, Dart and the like).
 */
export function withoutComments(file: string, text: string): string {
  const hash = /\.(py|pyi|rb|sh|bash)$/.test(file);
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const quote = text.startsWith('"""', i) ? '"""' : text.startsWith("'''", i) && hash ? "'''" : /["'`]/.test(text[i]!) ? text[i]! : undefined;
    if (quote) {
      let j = i + quote.length;
      while (j < text.length && !text.startsWith(quote, j)) {
        if (text[j] === "\\") j++;
        else if (quote.length === 1 && quote !== "`" && text[j] === "\n") break;
        j++;
      }
      i = j + quote.length;
      continue;
    }
    const line = hash ? text[i] === "#" : text.startsWith("//", i);
    if (line) {
      const end = text.indexOf("\n", i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (!hash && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Kotlin, Java, Swift, Python and other languages: double- or single-quoted string literals with `$x`, `${x}`, `{x}` or `%s` holes. */
export function callsFromText(file: string, original: string, spec: CallSource): Draft<Call>[] {
  const out: Draft<Call>[] = [];
  const text = withoutComments(file, original);
  const scopeAt = textScopes(text);
  for (const m of text.matchAll(STRING)) {
    const inner = (m[1] ?? m[2]!).replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*|%[sd]|\{[A-Za-z_]\w*\}/g, HOLE);
    const parsed = callPath(inner);
    if (!parsed) continue;
    const index = m.index ?? 0;
    const lineStart = text.lastIndexOf("\n", index) + 1;
    const lineEnd = text.indexOf("\n", index);
    const before = text.slice(lineStart, index);
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const verb = before.match(VERB_BEFORE)?.[1] ?? enumMethodNear(line, index - lineStart, index - lineStart + m[0].length);
    out.push({
      from: spec.from,
      to: spec.to,
      method: verb ? verb.toUpperCase() : "*",
      path: parsed.path,
      based: parsed.based,
      at: { file, line: lineOf(text, index) },
      evidence: "text",
      scope: scopeAt(index),
    });
  }
  return out;
}

/** `@{/path(params)}` in a Thymeleaf template; `~/` makes a path server-relative and is read the same way. */
const LINK_EXPRESSION = /@\{\s*~?(\/[^(){}\s]*(?:\{[^{}]*\}[^(){}\s]*)*)\s*(?:\([^)]*\))?\s*\}/g;
/** A root-relative URL written as an attribute value: `href="/x"`, `action="/x"`, `data-api-url="/x"`. */
const URL_ATTRIBUTE = /\b((?:th:)?(?:href|action|src|formaction)|data-[\w-]+)\s*=\s*["'](\/(?!\/)[^"'\s?#]*)/g;

/**
 * The attribute whose value holds `index`, lower-cased. Inside `th:attr="a=@{..},b=@{..}"`, and its `attrappend` and
 * `attrprepend` forms, the item the value belongs to names it.
 */
function attributeAt(text: string, index: number): string | undefined {
  const tagStart = text.lastIndexOf("<", index);
  if (tagStart < 0) return undefined;
  const attr = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  attr.lastIndex = tagStart;
  for (let m = attr.exec(text); m && m.index <= index; m = attr.exec(text)) {
    const valueStart = m.index + m[0].length - m[2]!.length + 1;
    const valueEnd = m.index + m[0].length - 1;
    if (index < valueStart || index >= valueEnd) continue;
    const name = m[1]!.toLowerCase();
    if (!/^th:attr(append|prepend)?$/.test(name)) return name;
    const item = text.slice(valueStart, index).split(",").pop() ?? "";
    return /^\s*([\w:.-]+)\s*=/.exec(item)?.[1]?.toLowerCase() ?? name;
  }
  return undefined;
}

/** The method a request from an attribute uses: GET for links, the form's method for an action, any for data values. */
function templateMethod(text: string, index: number, attribute: string | undefined): string {
  const name = attribute?.replace(/^th:/, "");
  if (name === "href" || name === "src") return "GET";
  if (name === "action" || name === "formaction") {
    const tagStart = text.lastIndexOf("<", index);
    const tagEnd = text.indexOf(">", index);
    const tag = text.slice(tagStart, tagEnd === -1 ? undefined : tagEnd);
    // th:method (PUT, DELETE through Spring's hidden method field) wins over the HTML method.
    const method = /\bth:method\s*=\s*["']([A-Za-z]+)["']/.exec(tag)?.[1] ?? /\bmethod\s*=\s*["']([A-Za-z]+)["']/.exec(tag)?.[1];
    return method ? method.toUpperCase() : "GET";
  }
  return "*";
}

/**
 * Requests an HTML template makes: Thymeleaf link expressions (`@{/reviews/{id}(id=${...})}`) and root-relative URLs
 * in `href`, `action`, `src` and `data-*` attributes. A `{name}` placeholder is any segment text. A `data-*` URL that
 * ends in `/` is a base a script appends to, so it stands for one more segment. Absolute URLs name other sites and are
 * not read.
 */
export function callsFromTemplate(file: string, text: string, spec: CallSource): Draft<Call>[] {
  const out: Draft<Call>[] = [];
  const seen = new Set<number>();
  const add = (raw: string, index: number) => {
    if (seen.has(index)) return;
    seen.add(index);
    const attribute = attributeAt(text, index);
    const base = attribute?.startsWith("data-") && raw.length > 1 && raw.endsWith("/");
    const parsed = callPath(`${raw.replace(/\{[^{}]*\}/g, HOLE)}${base ? HOLE : ""}`);
    if (!parsed) return;
    out.push({
      from: spec.from,
      to: spec.to,
      method: templateMethod(text, index, attribute),
      path: parsed.path,
      based: false,
      at: { file, line: lineOf(text, index) },
      evidence: "text",
    });
  };
  for (const m of text.matchAll(LINK_EXPRESSION)) add(m[1]!, m.index ?? 0);
  for (const m of text.matchAll(URL_ATTRIBUTE)) add(m[2]!, (m.index ?? 0) + m[0].length - m[2]!.length);
  return out.sort((a, b) => a.at.line - b.at.line);
}

export function extractCalls(source: Source, config: Config, coverage: Coverage[] = []): Draft<Call>[] {
  const out: Draft<Call>[] = [];
  for (const spec of config.calls) {
    const files = select(source, spec.files, config.exclude);
    const before = out.length;
    for (const file of files) {
      const text = source.read(file);
      if (text === undefined) continue;
      if (/\.(c|m)?[tj]sx?$/.test(file)) out.push(...callsFromTypeScript(file, text, spec));
      else if (/\.html?$/.test(file)) out.push(...callsFromTemplate(file, text, spec));
      else out.push(...callsFromText(file, text, spec));
    }
    addCoverage(coverage, `calls ${spec.from}->${spec.to}`, files.length, out.length - before);
  }
  return out;
}
