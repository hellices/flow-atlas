import ts from "typescript";
import type { CallSource, Config } from "../config.js";
import type { Call, Coverage, Draft } from "../model.js";
import { callPath, HOLE, joinRoute } from "../paths.js";
import { lineOf, select, type Source } from "../source.js";
import { addCoverage } from "./coverage.js";
import { declarationOf, unwrap } from "./binding.js";
import type { Spans } from "./spans.js";
import { scopeOf, textScopes } from "./reach.js";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** What a URL expression's leading value stands for, when the code states it; undefined leaves a hole. */
type Lead = (expr: ts.Expression) => string | undefined;

function templateText(node: ts.TemplateExpression, lead?: Lead): string {
  let s = node.head.text;
  node.templateSpans.forEach((span, i) => {
    s += (i === 0 && !s && lead?.(span.expression)) || HOLE;
    s += span.literal.text;
  });
  return s;
}

const isPlus = (node: ts.Node): node is ts.BinaryExpression => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;

/**
 * The text a string concatenation builds, its operands in order, with a hole for each operand that is not a literal:
 * `BASE + "/reviews"` reads as a template `${BASE}/reviews` would. Undefined when no operand is a string.
 */
function concatenationText(node: ts.BinaryExpression, lead?: Lead): string | undefined {
  const parts: string[] = [];
  let strings = 0;
  const walk = (written: ts.Expression): void => {
    // `(BASE)`, `BASE as string` and `BASE!` are BASE; a parenthesized sum is still one sum.
    const n = unwrap(written);
    const first = !parts.length && !isPlus(n) ? lead?.(n) : undefined;
    if (first !== undefined) {
      parts.push(first);
      strings++;
      return;
    }
    if (isPlus(n)) {
      walk(n.left);
      walk(n.right);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      parts.push(n.text);
      strings++;
    } else if (ts.isTemplateExpression(n)) {
      parts.push(templateText(n, lead));
      strings++;
    } else parts.push(HOLE);
  };
  walk(node);
  if (!strings) return undefined;
  let text = parts.join("");
  while (text.includes(HOLE + HOLE)) text = text.replace(HOLE + HOLE, HOLE);
  return text;
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

/** The `const` with an initializer that the name used at `id` refers to, by its lexical scopes; undefined otherwise. */
function constFor(id: ts.Identifier): ts.VariableDeclaration | undefined {
  const d = declarationOf(id);
  return d && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.initializer && d.parent.flags & ts.NodeFlags.Const ? d : undefined;
}

export function callsFromTypeScript(file: string, text: string, spec: CallSource, spans?: Spans): Draft<Call>[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<{ node: ts.Node; call: Draft<Call> }> = [];
  // A `const` URL that other URLs start with, and that nothing else uses, is their base, not a request of its own.
  const leads = new Map<ts.VariableDeclaration, Set<ts.Identifier>>();
  const urlText = (node: ts.Node, depth: number): string | undefined => {
    const lead: Lead = (expr) => {
      if (depth > 4 || !ts.isIdentifier(expr)) return undefined;
      const decl = constFor(expr);
      const value = decl?.initializer ? urlText(decl.initializer, depth + 1) : undefined;
      if (value === undefined || !callPath(value)) return undefined;
      (leads.get(decl!) ?? leads.set(decl!, new Set()).get(decl!)!).add(expr);
      return value;
    };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    // A const that names another (`const BASE = API`) has its value.
    if (ts.isIdentifier(node)) return lead(node);
    if (ts.isTemplateExpression(node)) return templateText(node, lead);
    if (isPlus(node)) return concatenationText(node, lead);
    if (unwrap(node as ts.Expression) !== node) return urlText(unwrap(node as ts.Expression), depth);
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    let raw: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) raw = urlText(node, 0);
    // A whole concatenation is one URL; its pieces alone are not requests.
    const whole = isPlus(node) && !isPlus(node.parent) && !(ts.isParenthesizedExpression(node.parent) && isPlus(node.parent.parent));
    if (whole) raw = urlText(node, 0);
    if (raw !== undefined) {
      const parsed = spans?.holds(file, node.getStart(sf)) ? undefined : callPath(raw);
      if (parsed) {
        found.push({ node, call: {
          from: spec.from,
          to: spec.to,
          method: methodNear(node),
          path: parsed.path,
          based: parsed.based,
          at: { file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 },
          evidence: "static",
          scope: scopeOf(node),
        } });
      }
      if (whole || !ts.isTemplateExpression(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // One pass over the file: a base used anywhere but at the start of a URL is a request of its own too.
  const names = new Set([...leads.keys()].map((d) => (d.name as ts.Identifier).text));
  const usedElsewhere = new Set<ts.VariableDeclaration>();
  const uses = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && names.has(n.text)) {
      const decl = declarationOf(n);
      if (decl && ts.isVariableDeclaration(decl) && n !== decl.name && leads.has(decl) && !leads.get(decl)!.has(n)) usedElsewhere.add(decl);
    }
    ts.forEachChild(n, uses);
  };
  if (names.size) uses(sf);
  const bases = new Set<ts.Node>();
  // The request list holds the literal itself, inside any parentheses or assertion around it.
  for (const decl of leads.keys()) if (!usedElsewhere.has(decl)) bases.add(unwrap(decl.initializer!));
  return found.filter((f) => !bases.has(f.node)).map((f) => f.call);
}

const STRING = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;

/**
 * Where the f-string replacement field whose text starts at `from` ends, after its `}`. In the expression, quoted strings
 * (`{'}'}`) and brackets hold their braces; after a top-level `:` comes the format spec, literal text in which only a
 * nested field (`{width}`) opens.
 */
function fieldEnd(body: string, from: number, expression?: (start: number, end: number) => void): number {
  let depth = 0;
  let spec = false;
  for (let i = from; i < body.length; i++) {
    const c = body[i]!;
    if (spec) {
      if (c === "{") i = fieldEnd(body, i + 1, expression) - 1;
      else if (c === "}") return i + 1;
    } else if (c === "'" || c === '"') {
      const quote = body.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      for (i += quote.length; i < body.length && !body.startsWith(quote, i); i++) if (body[i] === "\\") i++;
      i += quote.length - 1;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "}") {
      if (depth === 0) {
        expression?.(from, i);
        return i + 1;
      }
      depth--;
    } else if (c === ":" && depth === 0) {
      expression?.(from, i);
      spec = true;
    }
  }
  return body.length;
}

/**
 * A Python f-string's text with each replacement field a hole, nested fields (`{value:{width}}`) included, and `{{`
 * and `}}` the literal braces they write.
 */
function fStringText(body: string, expression?: (start: number, end: number) => void): string {
  let out = "";
  for (let i = 0; i < body.length; ) {
    const c = body[i]!;
    if ((c === "{" || c === "}") && body[i + 1] === c) {
      out += c;
      i += 2;
    } else if (c === "{") {
      i = fieldEnd(body, i + 1, expression);
      out += HOLE;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
/** A verb call whose first argument the string is, also when the string starts the next line; `\w{0,2}` takes a prefix such as `f` or `rb`. */
const VERB_BEFORE = /\.(get|post|put|patch|delete|head|options)\s*(?:<[^()]*>\s*)?\(\s*\w{0,2}$/i;
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
export function callsFromText(file: string, original: string, spec: CallSource, spans?: Spans): Draft<Call>[] {
  const out: Draft<Call>[] = [];
  const text = withoutComments(file, original);
  const scopeAt = textScopes(text);
  const read = (segment: string, offset: number): void => {
    for (const m of segment.matchAll(STRING)) read1(m, offset + (m.index ?? 0));
  };
  const read1 = (m: RegExpMatchArray, index: number): void => {
    // A route's own path is no request; the code in its f-string fields still runs, and is read below.
    const registered = spans?.holds(file, index);
    const body = m[1] ?? m[2]!;
    // In a Python f-string every replacement field is a value, however it is written; `{{` and `}}` are braces. The
    // code in a field runs, so the requests written in it are read too.
    const fString = /\.pyi?$/.test(file) && /(?<![\w])(?:[fF][rR]?|[rR][fF])$/.test(text.slice(Math.max(0, index - 2), index));
    const fields: Array<[number, number]> = [];
    const inner = fString ? fStringText(body, (start, end) => fields.push([start, end])) : body.replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*|%[sd]|\{[A-Za-z_]\w*\}/g, HOLE);
    for (const [start, end] of fields) read(body.slice(start, end), index + 1 + start);
    if (registered) return;
    const parsed = callPath(inner);
    if (!parsed) return;
    const lineStart = text.lastIndexOf("\n", index) + 1;
    const lineEnd = text.indexOf("\n", index);
    const before = text.slice(Math.max(0, index - 200), index);
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
  };
  read(text, 0);
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
    } else if (original[i] === "<" && /^<(script|style)(?=[\s/>])/i.test(original.slice(i, i + 8))) {
      tag.lastIndex = i;
      const m = tag.exec(original);
      if (!m) {
        i++;
        continue;
      }
      const name = m[1]!.toLowerCase();
      const bodyStart = i + m[0].length;
      // The end tag names the element exactly: `</script-widget>` in a script body does not close it.
      const end = new RegExp(`</${name}(?=[\\s/>])`, "gi");
      end.lastIndex = bodyStart;
      const close = end.exec(original)?.index;
      const bodyEnd = close ?? original.length;
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

const valueOf = (tag: StartTag, name: string): string | undefined => tag.attributes.find((a) => a.name === name)?.value;

/**
 * The method a submission named by `method` or `formmethod` (`plain`) uses, or undefined when the tag names none; null
 * when it sends nothing.
 *
 * Thymeleaf's attribute (`th:` or the HTML-friendly `data-th-`) replaces the plain one. It writes `method="post"` and,
 * for any other method, a hidden `_method` field that Spring turns into that method only when its
 * HiddenHttpMethodFilter is on, which Spring Boot leaves off: GET and POST are kept, any other value is `*`.
 *
 * The plain attribute is the HTML standard's enumerated one: `get` and `post`; `dialog`, which closes a dialog and sends
 * nothing; and GET for any other value, as a browser does.
 */
function submitMethod(tag: StartTag, plain: string): string | null | undefined {
  for (const name of [`th:${plain}`, `data-th-${plain}`]) {
    const value = valueOf(tag, name)?.trim().toLowerCase();
    if (value === undefined) continue;
    return value === "get" || value === "post" ? value.toUpperCase() : "*";
  }
  const value = valueOf(tag, plain)?.trim().toLowerCase();
  if (value === undefined) return undefined;
  if (value === "post") return "POST";
  return value === "dialog" ? null : "GET";
}

/**
 * The `<form>` a submit control belongs to: the one its `form` attribute names, else the one around it. Both are
 * found among the template's start tags and in its markup, so text in a script body is neither.
 */
function formOf(page: Page, control: StartTag): StartTag | undefined {
  const id = valueOf(control, "form");
  if (id !== undefined) {
    const named = page.tags.find((t) => t.name === "form" && valueOf(t, "id") === id);
    if (named) return named;
  }
  const open = page.tags.filter((t) => t.name === "form" && t.start < control.start).pop();
  if (!open || page.markup.toLowerCase().lastIndexOf("</form", control.start) > open.start) return undefined;
  return open;
}

interface Attribute {
  /** Lower-cased. */
  name: string;
  value: string;
  /** Where the value starts in the template. */
  at: number;
}

interface StartTag {
  /** Lower-cased. */
  name: string;
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

/** A template's markup (raw-text bodies blanked, offsets kept) and its start tags, values located in the template. */
interface Page {
  markup: string;
  tags: StartTag[];
}

function pageOf(text: string, raw: RawText[]): Page {
  const chars = text.split("");
  for (const r of raw) for (let k = r.bodyStart; k < r.bodyEnd; k++) if (chars[k] !== "\n") chars[k] = " ";
  const markup = chars.join("");
  const tags: StartTag[] = [];
  for (const m of markup.matchAll(START_TAG)) {
    const start = m.index ?? 0;
    tags.push({ name: m[1]!.toLowerCase(), start, text: text.slice(start, start + m[0].length), attributes: attributesOf(m[2]!, start + 1 + m[1]!.length) });
  }
  return { markup, tags };
}

/** The MIME type essences a browser runs a script of, besides `module`. */
const JAVASCRIPT_TYPES = new Set([
  "module",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
  "application/x-javascript",
  "application/x-ecmascript",
  "text/x-javascript",
  "text/x-ecmascript",
  "text/jscript",
  "text/livescript",
]);

/** Attributes that make a request: links, form targets, sources, and data attributes a script reads a URL from. */
const requests = (name: string): boolean => /^(href|src|action|formaction)$/.test(name) || name.startsWith("data-");

/** The `th:attr` family item a value belongs to: the attribute named before the `=` that precedes it. */
function itemName(value: string, offset: number): string | undefined {
  const item = value.slice(0, offset).split(",").pop() ?? "";
  return /^\s*([\w:.-]+)\s*=/.exec(item)?.[1]?.toLowerCase();
}

/**
 * The method a request from an attribute uses, or null when it sends none: GET for links and sources; a form's method
 * (`submitMethod`), GET when it names none; a submit control's `formmethod`, else its form's; any method for a `data-*`
 * URL, which a script reads.
 */
function templateMethod(page: Page, tag: StartTag, name: string): string | null {
  if (name === "href" || name === "src") return "GET";
  // `??` would also replace null, which means no request.
  const or = (method: string | null | undefined, fallback: string | null) => (method === undefined ? fallback : method);
  if (name === "action") return or(submitMethod(tag, "method"), "GET");
  if (name === "formaction") {
    const form = formOf(page, tag);
    return or(submitMethod(tag, "formmethod"), or(form ? submitMethod(form, "method") : undefined, "GET"));
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
  const page = pageOf(text, raw);
  const out: Draft<Call>[] = [];
  const add = (raw: string, index: number, tag: StartTag | undefined, name: string) => {
    const base = name.startsWith("data-") && raw.length > 1 && raw.endsWith("/");
    const parsed = callPath(`${raw.replace(/\{[^{}]*\}/g, HOLE)}${base ? HOLE : ""}`);
    const method = tag ? templateMethod(page, tag, name) : "*";
    if (!parsed || method === null) return;
    out.push({
      from: spec.from,
      to: spec.to,
      method,
      path: parsed.path,
      based: false,
      at: { file, line: lineOf(text, index) },
      evidence: "text",
    });
  };

  for (const tag of page.tags) {
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
    // A MIME type's essence, without parameters such as `; charset=utf-8`; no type or an empty one is JavaScript.
    const type = attribute("type")?.split(";")[0]!.trim().toLowerCase();
    if (attribute("src") !== undefined || (type && !JAVASCRIPT_TYPES.has(type))) continue;
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

/** `spans`: where route registrations write their paths (see `extractRoutes`); strings there are not requests. */
export function extractCalls(source: Source, config: Config, coverage: Coverage[] = [], spans?: Spans): Draft<Call>[] {
  const out: Draft<Call>[] = [];
  for (const spec of config.calls) {
    const files = select(source, spec.files, config.exclude);
    const before = out.length;
    for (const file of files) {
      const text = source.read(file);
      if (text === undefined) continue;
      const read = /\.(c|m)?[tj]sx?$/.test(file)
        ? callsFromTypeScript(file, text, spec, spans)
        : /\.html?$/.test(file)
          ? callsFromTemplate(file, text, spec)
          : callsFromText(file, text, spec, spans);
      // The path a configured client puts before each root-relative path; a URL with a base of its own keeps it.
      out.push(...(spec.prefix ? read.map((c) => (c.based ? c : { ...c, path: joinRoute(spec.prefix!, c.path) })) : read));
    }
    addCoverage(coverage, `calls ${spec.from}->${spec.to}`, files.length, out.length - before);
  }
  return out;
}
