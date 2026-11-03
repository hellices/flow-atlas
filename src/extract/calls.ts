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
/**
 * Where a string literal opened by `quote` at `start` ends (just past its closing quote). A backslash escapes the next
 * character, except in a Kotlin raw string (`"""` in a `.kt` file), which has no escapes and whose run of closing
 * quotes ends at its last three. A one-character quote other than a backtick ends at a line break.
 */
export function literalEnd(text: string, start: number, quote: string, file: string): number {
  const raw = quote === '"""' && /\.kts?$/.test(file);
  let j = start + quote.length;
  while (j < text.length && !text.startsWith(quote, j)) {
    if (text[j] === "\\" && !raw) j++;
    else if (quote.length === 1 && quote !== "`" && text[j] === "\n") return j;
    j++;
  }
  if (raw) while (text[j + 3] === '"') j++;
  return Math.min(j + quote.length, text.length);
}

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
      i = literalEnd(text, i, quote, file);
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

/** A `<script>` or `<style>` element: its start tag and where its raw-text body lies in the template. */
interface RawText {
  name: string;
  attributes: Attribute[];
  bodyStart: number;
  bodyEnd: number;
}

// The template as HTML reads it, in one pass: comments blanked (newlines and offsets kept), and the <script> and
// <style> elements found, whose bodies are raw text, where neither a comment nor markup can start. Thymeleaf's
// parser-level comments start with "<!--" too and are blanked; its prototype-only block, opened by "<!--/*/" and
// closed by "/*/-->", is processed, so only the two markers are blanked and comments inside it still are.
function scanHtml(original: string): { text: string; raw: RawText[] } {
  const out = original.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const raw: RawText[] = [];
  const tag = new RegExp(START_TAG.source, "y");
  let prototype = false;
  let i = 0;
  while (i < original.length) {
    if (prototype && original.startsWith("/*/-->", i)) {
      blank(i, i + 6);
      prototype = false;
      i += 6;
    } else if (original.startsWith("<!--/*/", i)) {
      blank(i, i + 7);
      prototype = true;
      i += 7;
    } else if (original.startsWith("<!--", i)) {
      const close = original.indexOf("-->", i + 4);
      const end = close < 0 ? original.length : close + 3;
      blank(i, end);
      i = end;
    } else if (original[i] === "<" && /^<(script|style)\b/i.test(original.slice(i, i + 7))) {
      tag.lastIndex = i;
      const m = tag.exec(original);
      if (!m) {
        i++;
        continue;
      }
      const name = m[1]!.toLowerCase();
      const bodyStart = i + m[0].length;
      const close = original.toLowerCase().indexOf(`</${name}`, bodyStart);
      const bodyEnd = close < 0 ? original.length : close;
      raw.push({ name, attributes: attributesOf(m[2]!, i + 1 + m[1]!.length), bodyStart, bodyEnd });
      i = bodyEnd;
    } else i++;
  }
  return { text: out.join(""), raw };
}

/**
 * The path of the Thymeleaf link expression starting at `@{`: its `/...` literal with `{name}` placeholders, up to
 * the parameter list or the closing brace. The parameters may hold any expression; they are not read.
 */
function linkPath(text: string, at: number): string | undefined {
  let i = at + 2;
  while (/\s/.test(text[i] ?? "")) i++;
  if (text[i] === "~") i++;
  if (text[i] !== "/") return undefined;
  let path = "";
  while (i < text.length) {
    const c = text[i]!;
    if (c === "{") {
      const close = text.indexOf("}", i);
      if (close < 0) return undefined;
      path += text.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (c === "(" || c === "}" || /\s/.test(c)) break;
    path += c;
    i++;
  }
  return path;
}

/** The tag that holds `index`: from its `<` to its `>`. */
function tagAt(text: string, index: number): { start: number; text: string } {
  const start = text.lastIndexOf("<", index);
  const end = text.indexOf(">", index);
  return { start, text: text.slice(start, end === -1 ? undefined : end + 1) };
}

const methodOf = (tag: string, plain: string): string | undefined =>
  new RegExp(`\\bth:${plain}\\s*=\\s*["']([A-Za-z]+)["']`, "i").exec(tag)?.[1] ?? new RegExp(`(?<![\\w:-])${plain}\\s*=\\s*["']([A-Za-z]+)["']`, "i").exec(tag)?.[1];

/** The `<form>` a submit control belongs to: the one its `form` attribute names, else the one around it. */
function formOf(text: string, index: number, control: string): string | undefined {
  const id = /(?<![\w:-])form\s*=\s*["']([^"']+)["']/i.exec(control)?.[1];
  if (id) {
    const named = new RegExp(`<form\\b[^>]*(?<![\\w:-])id\\s*=\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`, "i").exec(text);
    if (named) return named[0];
  }
  const open = text.toLowerCase().lastIndexOf("<form", index);
  if (open < 0 || text.toLowerCase().lastIndexOf("</form", index) > open) return undefined;
  return tagAt(text, open + 1).text;
}

interface Attribute {
  /** Lower-cased. */
  name: string;
  value: string;
  /** Where the value starts in the template. */
  at: number;
}

interface StartTag {
  start: number;
  text: string;
  attributes: Attribute[];
}

const START_TAG = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/** The attributes of a start tag's attribute list, which begins at `listAt` in the template. */
function attributesOf(list: string, listAt: number): Attribute[] {
  const out: Attribute[] = [];
  for (const a of list.matchAll(ATTRIBUTE)) {
    const value = a[2] ?? a[3] ?? a[4];
    if (value === undefined) continue;
    const eq = a[0].indexOf("=");
    let k = eq + 1;
    while (/\s/.test(a[0][k] ?? "")) k++;
    if (a[0][k] === '"' || a[0][k] === "'") k++;
    out.push({ name: a[1]!.toLowerCase(), value, at: listAt + (a.index ?? 0) + k });
  }
  return out;
}

/** The template's start tags with their attributes, values located in the template; raw-text bodies hold no tags. */
function startTags(text: string, raw: RawText[]): StartTag[] {
  const markup = text.split("");
  for (const r of raw) for (let k = r.bodyStart; k < r.bodyEnd; k++) if (markup[k] !== "\n") markup[k] = " ";
  const out: StartTag[] = [];
  for (const m of markup.join("").matchAll(START_TAG)) {
    const start = m.index ?? 0;
    out.push({ start, text: text.slice(start, start + m[0].length), attributes: attributesOf(m[2]!, start + 1 + m[1]!.length) });
  }
  return out;
}

/** Attributes that make a request: links, form targets, sources, and data attributes a script reads a URL from. */
const requests = (name: string): boolean => /^(href|src|action|formaction)$/.test(name) || name.startsWith("data-");

/** The `th:attr` family item a value belongs to: the attribute named before the `=` that precedes it. */
function itemName(value: string, offset: number): string | undefined {
  const item = value.slice(0, offset).split(",").pop() ?? "";
  return /^\s*([\w:.-]+)\s*=/.exec(item)?.[1]?.toLowerCase();
}

/**
 * The method a request from an attribute uses: GET for links and sources; a form's `th:method` (PUT, DELETE through
 * Spring's hidden method field) or `method`; a submit control's `formmethod`, else its form's; any method for a `data-*`
 * URL, which a script reads.
 */
function templateMethod(text: string, tag: StartTag, name: string): string {
  if (name === "href" || name === "src") return "GET";
  if (name === "action") return (methodOf(tag.text, "method") ?? "GET").toUpperCase();
  if (name === "formaction") {
    const form = formOf(text, tag.start, tag.text);
    return (methodOf(tag.text, "formmethod") ?? (form ? methodOf(form, "method") : undefined) ?? "GET").toUpperCase();
  }
  return "*";
}

/**
 * Requests an HTML template makes, read from start tags only:
 * - Thymeleaf link expressions (`@{/reviews/{id}(id=${...})}`) in `th:href`, `th:src`, `th:action`, `th:formaction`,
 *   `th:data-*` and the items of `th:attr` naming those attributes. `th:attrappend` and `th:attrprepend` add their
 *   value to the static attribute, so the request is the two joined, and nothing when there is no static value;
 * - root-relative URLs in `href`, `src`, `action`, `formaction` and `data-*`, in any case, unless Thymeleaf replaces the
 *   attribute;
 * - in inline scripts, the requests the JavaScript makes and, where Thymeleaf inlines JavaScript, link expressions in
 *   `[[...]]` or `[(...)]`.
 * A `{name}` placeholder is any segment text; a `data-*` URL ending in `/` is a base a script appends one segment to.
 * Text that is not an attribute, commented-out markup and absolute URLs, which name other sites, are not read.
 */
export function callsFromTemplate(file: string, original: string, spec: CallSource): Draft<Call>[] {
  const { text, raw } = scanHtml(original);
  const out: Draft<Call>[] = [];
  const add = (raw: string, index: number, tag: StartTag | undefined, name: string) => {
    const base = name.startsWith("data-") && raw.length > 1 && raw.endsWith("/");
    const parsed = callPath(`${raw.replace(/\{[^{}]*\}/g, HOLE)}${base ? HOLE : ""}`);
    if (!parsed) return;
    out.push({
      from: spec.from,
      to: spec.to,
      method: tag ? templateMethod(text, tag, name) : "*",
      path: parsed.path,
      based: false,
      at: { file, line: lineOf(text, index) },
      evidence: "text",
    });
  };

  for (const tag of startTags(text, raw)) {
    const plain = new Map(tag.attributes.filter((a) => !a.name.startsWith("th:") && !a.name.startsWith("data-th-")).map((a) => [a.name, a]));
    const replaced = new Set<string>();
    const joined = new Set<string>();
    for (const a of tag.attributes) {
      const th = /^(?:th:|data-th-)(.+)$/.exec(a.name)?.[1];
      if (!th) continue;
      const family = /^attr(append|prepend)?$/.exec(th);
      for (let i = a.value.indexOf("@{"); i >= 0; i = a.value.indexOf("@{", i + 2)) {
        const name = family ? itemName(a.value, i) : th;
        const path = linkPath(a.value, i);
        if (!name || !requests(name) || !path) continue;
        if (!family || !family[1]) {
          replaced.add(name);
          add(path, a.at + i, tag, name);
          continue;
        }
        // attrappend / attrprepend: the request is the static value with this added, if the static value is known.
        joined.add(name);
        const fixed = plain.get(name);
        if (!fixed || !fixed.value.startsWith("/")) continue;
        add(family[1] === "append" ? `${fixed.value}${path}` : `${path}${fixed.value}`, fixed.at, tag, name);
      }
      if (!family) replaced.add(th);
      else if (!family[1]) for (const item of a.value.split(",")) {
        const n = /^\s*([\w:.-]+)\s*=/.exec(item)?.[1]?.toLowerCase();
        if (n) replaced.add(n);
      }
    }
    for (const a of plain.values()) {
      if (!requests(a.name) || replaced.has(a.name) || joined.has(a.name)) continue;
      if (!a.value.startsWith("/") || a.value.startsWith("//")) continue;
      add(a.value.replace(/[?#].*$/, ""), a.at, tag, a.name);
    }
  }

  // Inline scripts, without a src: their requests, at their lines in the template.
  for (const script of raw.filter((r) => r.name === "script")) {
    const attribute = (name: string) => script.attributes.find((a) => a.name === name)?.value;
    const type = attribute("type")?.trim().toLowerCase();
    if (attribute("src") !== undefined || (type && !/^(text\/javascript|module|application\/javascript)$/.test(type))) continue;
    const body = text.slice(script.bodyStart, script.bodyEnd);
    const shift = lineOf(text, script.bodyStart) - 1;
    for (const c of callsFromTypeScript(`${file}.js`, body, spec)) out.push({ ...c, at: { file, line: c.at.line + shift } });
    if (attribute("th:inline")?.toLowerCase() === "javascript") {
      for (const e of body.matchAll(/\[[[(]\s*@\{/g)) {
        const at = (e.index ?? 0) + e[0].length - 2;
        const path = linkPath(body, at);
        if (path) add(path, script.bodyStart + at, undefined, "script");
      }
    }
  }
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
