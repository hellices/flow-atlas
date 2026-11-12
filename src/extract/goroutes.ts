import { posix } from "node:path";
import type { Dispatch } from "../model.js";
import { lineOf } from "../source.js";
import { parseGo, tokenize, type Block, type Expr, type Field, type FuncDecl, type FuncType, type GoFile, type Stmt } from "./golang.js";

/**
 * The routes Go services register with Gin (github.com/gin-gonic/gin), chi (github.com/go-chi/chi/v5) and net/http's
 * ServeMux, read from the code as each library registers them and where it serves them:
 *
 * - Gin: an engine (`gin.New()`, `gin.Default()`) and its groups (`Group(path)`, nested, each joined to its parent's
 *   path by `joinPaths`), `GET` and the other method functions, `Handle`, `Any`, `Match`, and `Static`, `StaticFS` and
 *   `StaticFile`, which serve files with GET and HEAD (routergroup.go).
 * - chi: a router (`chi.NewRouter()`), its method functions, `Method`, `Handle` and `HandleFunc` (any method, or the
 *   method the pattern starts with), `Group` and `With` (the same router), `Route` (a new router mounted at the
 *   pattern) and `Mount` (mux.go).
 * - net/http: a `ServeMux` (`http.NewServeMux()`, or the `DefaultServeMux` behind `http.Handle` and
 *   `http.HandleFunc`), its patterns read as Go 1.22 parses them (`[METHOD ][HOST]/[PATH]`, net/http/pattern.go), and a
 *   router served under a subtree through `http.StripPrefix`.
 *
 * Routers are followed as the code passes them: through variables, blocks and closures, the functions of the route
 * files' packages that take or return one (a call's arguments bound to the function's parameters), struct fields and
 * methods, and constants. Each function is read once for each call that reaches it, from the functions no code of the
 * route files calls. A router no read code mounts is served at the root; a registration on a value atlas does not trace
 * to a router is not read, and a limit names it.
 */

/** A route a Go router serves: its path in atlas's form, with its parameters' regexps and how its router dispatches it. */
export interface GoRoute {
  method: string;
  path: string;
  patterns?: Record<string, string>;
  file: string;
  line: number;
  implicit?: true;
  convention?: string;
  dispatch: Dispatch;
}

type Lib = "gin" | "chi" | "mux";

/** Where a router is mounted on another: under a path its library joins to the mounted router's paths. */
interface Mount {
  parent: Router;
  /** chi: the mount pattern as written (`/admin`, `/{id}`, `/x/`); mux: the path StripPrefix removes; undefined when not read. */
  prefix: string | undefined;
  how: "chi" | "strip" | "root";
  /** mux: the pattern the router is served under. */
  pattern?: string;
  file: string;
  line: number;
}

interface Router {
  id: number;
  lib: Lib;
  file: string;
  line: number;
  /** A path `mounts` configures for the routers of this file, served there in place of any mount read. */
  declared?: string;
  mounts: Mount[];
  regs: Reg[];
  /** Gin's RedirectTrailingSlash: true (the default), false, or null where it is set to a value not read. */
  tsr?: boolean | null;
  /** Why Gin's settings are not read (options given to `gin.New`). */
  unreadSettings?: string;
  /** chi middlewares (`middleware.StripSlashes`, `RedirectSlashes`) that rewrite a request's trailing `/` before routing. */
  rewrites?: string[];
  /** chi's `middleware.GetHead`: a HEAD request no HEAD route takes is routed as a GET. */
  headByGet?: true;
  /** chi middlewares that route a request by another path than it names (`URLFormat`, `StripPrefix`, `PathRewrite`). */
  pathRewrites?: string[];
  /** The Go version of the module the ServeMux's patterns are written in, and whether GODEBUG asks for Go 1.21's mux. */
  go?: { version: string | undefined; legacy: boolean; file: string | undefined };
  /** The DefaultServeMux. */
  default?: true;
  /**
   * Where the router is put in a value atlas does not follow (a map, a slice, an index, another package's struct), or
   * handed to a registration on a value atlas does not trace.
   */
  escaped?: string;
}

/** A route registration on a router: the path as the router holds it, the methods, and what serves it. */
interface Reg {
  router: Router;
  /** Gin: the absolute path (`joinPaths` of the group's and the route's); chi: the pattern; mux: the path of the pattern. */
  path: string;
  /** The methods, or `*` for any. */
  methods: string[] | "*";
  file: string;
  line: number;
  implicit?: true;
  convention?: string;
  /** chi: a handler `Mount` serves for any method at the pattern, the pattern with a `/` and everything under it. */
  mountAll?: true;
}

type V =
  /**
   * A router; for Gin, a group of its engine, `base` its path, undefined where not read; for chi, `inline` where it is
   * one `With` or `Group` makes, whose middlewares run after a route is found.
   */
  | { k: "router"; r: Router; base: string | undefined; inline?: true }
  | { k: "handler"; files: boolean; strip?: { prefix: string | undefined; inner: V } }
  | { k: "str"; value: string }
  | { k: "bool"; value: boolean }
  | { k: "strs"; values: string[] }
  | { k: "func"; fn: Fn; pkg: Pkg; scope: Scope | undefined; recv?: V; recvName?: string }
  /**
   * A struct: its fields where set (`byValue` where the value is the struct itself, copied as Go copies it, rather than
   * a pointer to it); `vague` says why its fields not set are unknown rather than zero, `untraced` where it is a
   * parameter or receiver no read call passes a value for.
   */
  | { k: "obj"; type: TypeRef; fields: Map<string, V>; byValue?: true; vague?: string; untraced?: true }
  | { k: "pkg"; path: string }
  | { k: "builtin"; pkg: string; name: string }
  | { k: "method"; recv: V & { k: "router" }; name: string }
  /** A value not read; `untraced` where it is a parameter, or a field of one, no read call passes a value for. */
  | { k: "unknown"; type?: RouterType; why?: string; untraced?: true };

/** A router type a declaration names (`*gin.Engine`, `chi.Router`, `*http.ServeMux`); `handler` for `http.Handler`. */
type RouterType = Lib | "gin-engine" | "handler";

/** A function's code: a declaration, or a literal, with the file it is written in. */
interface Fn {
  type: FuncType;
  body?: Block;
  name: string;
  file: string;
  /** The declaration's receiver, for a method. */
  recv?: Field;
  start: number;
}

interface TypeRef {
  pkg: Pkg;
  name: string;
}

const UNKNOWN: V = { k: "unknown" };

const GIN = "github.com/gin-gonic/gin";
const CHI = "github.com/go-chi/chi/v5";
const CHI_MIDDLEWARE = "github.com/go-chi/chi/v5/middleware";
const HTTP = "net/http";

/** The package names of the packages read, by import path; another's is the last element of its path. */
const KNOWN_NAMES: Record<string, string> = { [GIN]: "gin", [CHI]: "chi", [CHI_MIDDLEWARE]: "middleware", [HTTP]: "http" };

/** net/http's method constants (method.go). */
const HTTP_METHODS: Record<string, string> = {
  MethodGet: "GET",
  MethodHead: "HEAD",
  MethodPost: "POST",
  MethodPut: "PUT",
  MethodPatch: "PATCH",
  MethodDelete: "DELETE",
  MethodConnect: "CONNECT",
  MethodOptions: "OPTIONS",
  MethodTrace: "TRACE",
};

/** Gin's method functions (routergroup.go). */
const GIN_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
/** chi's method functions and the method each registers (mux.go). */
const CHI_VERBS: Record<string, string> = {
  Connect: "CONNECT",
  Delete: "DELETE",
  Get: "GET",
  Head: "HEAD",
  Options: "OPTIONS",
  Patch: "PATCH",
  Post: "POST",
  Put: "PUT",
  Query: "QUERY",
  Trace: "TRACE",
};
/** The methods chi knows without `RegisterMethod` (tree.go `methodMap`). */
const CHI_METHODS = new Set(Object.values(CHI_VERBS));

/** Go's `path.Clean`: the shortest path equal to `p` with `.` and `..` resolved and `/` runs collapsed. */
export function goClean(p: string): string {
  if (p === "") return ".";
  const rooted = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!rooted) out.push("..");
    } else out.push(seg);
  }
  const joined = out.join("/");
  if (rooted) return `/${joined}`;
  return joined || ".";
}

/** Go's `path.Join`: the non-empty elements joined with `/`, cleaned; empty where every element is. */
export function goJoin(...elems: string[]): string {
  const kept = elems.filter((e) => e !== "");
  return kept.length ? goClean(kept.join("/")) : "";
}

/** Gin's `joinPaths` (utils.go): `path.Join`, keeping the `/` the relative path ends with. */
export function ginJoin(absolute: string, relative: string): string {
  if (relative === "") return absolute;
  const final = goJoin(absolute, relative);
  return relative.endsWith("/") && !final.endsWith("/") ? `${final}/` : final;
}

/** The module a file belongs to, from the go.mod nearest above it: its path, its `go` version and its GODEBUG settings. */
interface Module {
  dir: string;
  path: string;
  file: string;
  go: string | undefined;
  /** `godebug httpmuxgo121=1`, which gives the ServeMux of Go 1.21 back. */
  legacyMux: boolean;
}

/** A package of the route files: its files, functions, methods, types and package-level declarations. */
interface Pkg {
  dir: string;
  /** The import path, where its module is read. */
  path: string | undefined;
  name: string;
  module: Module | undefined;
  files: Array<{ file: string; text: string; go: GoFile; imports: Map<string, string>; dots: string[] }>;
  funcs: Map<string, { decl: FuncDecl; file: string }>;
  /** Methods by `Type.Method`. */
  methods: Map<string, { decl: FuncDecl; file: string }>;
  types: Map<string, { type: Expr; file: string }>;
  values: Map<string, { kind: "var" | "const"; type?: Expr; value?: Expr; index: number; count: number; file: string }>;
  globals: Map<string, V>;
  /** The call from outside the packages (see `Interp.epoch`) each variable's value in `globals` was set in. */
  epochs: Map<string, number>;
}

/** The go.mod above a file, read through `read`; undefined where none is. */
function moduleOf(file: string, read: (path: string) => string | undefined, cache: Map<string, Module | null>): Module | undefined {
  for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) {
    const key = dir === "." ? "" : dir;
    if (cache.has(key)) return cache.get(key) ?? undefined;
    const path = key ? `${key}/go.mod` : "go.mod";
    const text = read(path);
    if (text !== undefined) {
      const code = text.replace(/\/\/.*$/gm, "");
      const name = /^\s*module\s+("?)([^\s"]+)\1/m.exec(code)?.[2];
      const go = /^\s*go\s+(\d+(?:\.\d+){0,2})\s*$/m.exec(code)?.[1];
      // `godebug key=value` or a `godebug ( ... )` block (go.dev/doc/godebug).
      const godebug = [...code.matchAll(/^\s*godebug\s+(?:\(([^)]*)\)|(\S+))/gm)].flatMap((m) => (m[1] ?? m[2] ?? "").split(/[\s,]+/));
      const m: Module | null = name ? { dir: key, path: name, file: path, go, legacyMux: godebug.includes("httpmuxgo121=1") } : null;
      cache.set(key, m);
      return m ?? undefined;
    }
    if (key === "") {
      cache.set(key, null);
      return undefined;
    }
  }
}

/** Whether Go version `v` (`1.22`, `1.22.3`, `1.21rc1`) is 1.22 or later. */
function atLeast122(v: string): boolean {
  const [major, minor] = v.split(".").map((n) => parseInt(n, 10));
  return (major ?? 0) > 1 || ((major ?? 0) === 1 && (minor ?? 0) >= 22);
}

/** The name a file imports a package under, by the package's clause where it is read, else its path's last element. */
function defaultName(path: string, local: Map<string, string>): string {
  if (Object.hasOwn(KNOWN_NAMES, path)) return KNOWN_NAMES[path]!;
  if (local.has(path)) return local.get(path)!;
  const parts = path.split("/");
  let last = parts[parts.length - 1] ?? path;
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts[parts.length - 2]!;
  return last.replace(/\.v\d+$/, "");
}

/** The packages of the Go files, by directory: a file's `_test.go` siblings are left out, as `go build` leaves them. */
function loadPackages(texts: Map<string, string>, read: (path: string) => string | undefined): Pkg[] {
  const modules = new Map<string, Module | null>();
  const byDir = new Map<string, Pkg>();
  for (const [file, text] of texts) {
    if (!file.endsWith(".go") || file.endsWith("_test.go")) continue;
    const go = parseGo(text);
    const dir = posix.dirname(file);
    const module = moduleOf(file, read, modules);
    let found = byDir.get(dir);
    if (!found) {
      const rel = module ? posix.relative(module.dir || ".", dir === "." ? "." : dir) : undefined;
      const path = module ? (rel && rel !== "." ? `${module.path}/${rel}` : module.path) : undefined;
      found = { dir, path, name: go.pkg, module, files: [], funcs: new Map(), methods: new Map(), types: new Map(), values: new Map(), globals: new Map(), epochs: new Map() };
      byDir.set(dir, found);
    }
    const pkg = found;
    pkg.files.push({ file, text, go, imports: new Map(), dots: [] });
    for (const f of go.funcs) {
      if (f.recv) {
        const type = receiverType(f.recv.type);
        if (type) pkg.methods.set(`${type}.${f.name}`, { decl: f, file });
      } else if (f.name !== "init" && f.name !== "_") pkg.funcs.set(f.name, { decl: f, file });
    }
    for (const d of go.decls) {
      for (const s of d.specs) {
        if (d.kind === "type") s.names.forEach((n) => s.type && pkg.types.set(n.name, { type: s.type, file }));
        else if (d.kind === "var" || d.kind === "const") {
          s.names.forEach((n, i) => {
            if (n.name !== "_") pkg.values.set(n.name, { kind: d.kind === "var" ? "var" : "const", ...(s.type ? { type: s.type } : {}), ...(s.values[i] ? { value: s.values[i] } : {}), index: i, count: s.names.length, file });
          });
        }
      }
    }
  }
  const pkgs = [...byDir.values()];
  const clauses = new Map(pkgs.filter((p) => p.path).map((p) => [p.path!, p.name]));
  for (const p of pkgs) {
    for (const f of p.files) {
      for (const imp of f.go.imports) {
        if (imp.name === "_") continue;
        if (imp.name === ".") f.dots.push(imp.path);
        else f.imports.set(imp.name ?? defaultName(imp.path, clauses), imp.path);
      }
    }
  }
  return pkgs;
}

/** The type name a method's receiver names: `T` of `t T`, `t *T` or `t *T[K]`. */
function receiverType(type: Expr): string | undefined {
  if (type.k === "unary" && type.op === "*") return receiverType(type.x);
  if (type.k === "paren") return receiverType(type.x);
  if (type.k === "index") return receiverType(type.x);
  return type.k === "ident" ? type.name : undefined;
}

/**
 * The functions and methods that name each function or method of the route files' packages in their bodies (a call,
 * or the function passed as a value): a function's own name in a package, or after a `.` in another, and a method's
 * after a `.` anywhere. Those no function names are where a program's calls into these packages start (a function
 * another package calls, a handler a library calls); top-level declarations other than functions count as callers too.
 */
function callersOf(pkgs: Pkg[]): Map<FuncDecl, Set<FuncDecl | null>> {
  const named = new Map<string, Array<{ file: string; start: number; dotted: boolean; qualifier?: string }>>();
  const importsOf = new Map(pkgs.flatMap((p) => p.files.map((f) => [f.file, f.imports] as const)));
  for (const p of pkgs) {
    for (const f of p.files) {
      const toks = tokenize(f.text);
      toks.forEach((t, i) => {
        // The package clause names the package, not a function (`package main`).
        if (t.kind !== "ident" || (toks[i - 1]?.kind === "keyword" && toks[i - 1]?.text === "package")) return;
        const dotted = toks[i - 1]?.text === "." && toks[i - 1]?.kind === "op";
        const before = toks[i - 2];
        (named.get(t.text) ?? named.set(t.text, []).get(t.text)!).push({ file: f.file, start: t.start, dotted, ...(dotted && before?.kind === "ident" ? { qualifier: before.text } : {}) });
      });
    }
  }
  const decls = new Map(pkgs.flatMap((p) => p.files.map((f) => [f.file, f.go.funcs] as const)));
  const enclosing = (file: string, at: number): FuncDecl | null => decls.get(file)?.find((d) => at >= d.start && at < d.end) ?? null;
  const out = new Map<FuncDecl, Set<FuncDecl | null>>();
  for (const p of pkgs) {
    const files = new Set(p.files.map((f) => f.file));
    const add = (decl: FuncDecl, file: string, method: boolean) => {
      const callers = new Set<FuncDecl | null>();
      for (const u of named.get(decl.name) ?? []) {
        if (u.file === file && u.start >= decl.start && u.start < decl.end) continue;
        // A method is named after a `.`; a function bare in its own package, or after the name another file imports
        // its package under.
        const qualified = u.qualifier !== undefined && p.path !== undefined && importsOf.get(u.file)?.get(u.qualifier) === p.path;
        if (method ? u.dotted : (files.has(u.file) && !u.dotted) || qualified) callers.add(enclosing(u.file, u.start));
      }
      out.set(decl, callers);
    };
    for (const { decl, file } of p.funcs.values()) add(decl, file, false);
    for (const { decl, file } of p.methods.values()) add(decl, file, true);
  }
  return out;
}

/** The names a block of code binds, each scope's own, looked up through the enclosing ones. */
class Scope {
  readonly vars = new Map<string, V>();
  constructor(readonly parent?: Scope) {}

  find(name: string): Scope | undefined {
    if (this.vars.has(name)) return this;
    return this.parent?.find(name);
  }
}

/** What a branch or loop body changed: for each map of variables or fields, the value of each key it assigned before it. */
type Journal = Map<Map<string, V>, Map<string, V | undefined>>;

/** What a function is read with: its package and file, and what its `return` statements give. */
interface Frame {
  pkg: Pkg;
  file: string;
  text: string;
  imports: Map<string, string>;
  dots: string[];
  returns: V[][];
  returned: boolean;
  fn: string;
  /** The names of the function's named results, which a bare `return` gives. */
  named: string[];
}

/** The most calls read in all, and the deepest chain of calls: a guard against runaway expansion. */
const MAX_CALLS = 20000;
const MAX_DEPTH = 32;
/** The most values a `range` over a literal list is read for. */
const MAX_RANGE = 64;

/**
 * The names the statements assign with `=` or an operator, outside function literals, and the fields of a name they
 * assign (`s.router`, written `s.router`): what a branch may change.
 */
function assignedNames(stmts: Stmt[], out = new Set<string>()): Set<string> {
  const target = (l: Expr) => {
    if (l.k === "ident") out.add(l.name);
    else if (l.k === "sel" && l.x.k === "ident") out.add(`${l.x.name}.${l.name}`);
  };
  const walk = (s: Stmt | undefined): void => {
    if (!s) return;
    switch (s.k) {
      case "assign":
        if (s.op !== ":=") s.lhs.forEach(target);
        else s.lhs.forEach((l) => l.k !== "ident" && target(l));
        break;
      case "range":
        if (!s.define) s.lhs.forEach(target);
        assignedNames(s.body.stmts, out);
        break;
      case "block":
        assignedNames(s.block.stmts, out);
        break;
      case "if":
        walk(s.init);
        assignedNames(s.then.stmts, out);
        walk(s.else);
        break;
      case "for":
        walk(s.init);
        walk(s.post);
        assignedNames(s.body.stmts, out);
        break;
      case "switch":
        walk(s.init);
        walk(s.tag);
        for (const c of s.clauses) assignedNames(c.body, out);
        break;
      case "labeled":
        walk(s.stmt);
        break;
      default:
        break;
    }
  };
  stmts.forEach(walk);
  return out;
}

class Interp {
  readonly routers: Router[] = [];
  readonly limits = new Set<string>();
  readonly spans: Array<{ file: string; start: number; end: number }> = [];
  /** Methods `chi.RegisterMethod` adds, which `Method` takes. */
  readonly chiMethods = new Set<string>();
  private readonly invoked = new Set<number>();
  /**
   * Which call from outside the packages is being read: 0 for `init` and `main`, which run first, each other function
   * no read code calls a number of its own.
   */
  private epoch = 0;
  /** The journals of the branches and loop bodies being read, innermost last (see `write`). */
  private readonly journals: Journal[] = [];
  /** How many branches or loop bodies, which may not run, the code being read is in. */
  private conditional = 0;
  /** The package-level variables (`dir\0name`) a function other than `init` assigns. */
  private mutable = new Set<string>();
  /** The calls read on a router, by `file:offset`. */
  private readonly handled = new Set<string>();
  /** The functions that may make, register on or return a router or a struct of these packages (see `relevant`). */
  private relevant = new Set<number>();
  private readonly stack: number[] = [];
  private calls = 0;
  private exhausted = false;
  private readonly byPath = new Map<string, Pkg>();
  private defaultMux: Router | undefined;
  private nextId = 0;

  constructor(
    private readonly pkgs: Pkg[],
    private readonly component: string,
    private readonly declared: Record<string, string>,
  ) {
    for (const p of pkgs) if (p.path) this.byPath.set(p.path, p);
  }

  /** `file:line` of an offset. */
  at(file: string, offset: number): string {
    return `${file}:${this.line(file, offset)}`;
  }

  line(file: string, offset: number): number {
    const text = this.pkgs.flatMap((p) => p.files).find((f) => f.file === file)?.text ?? "";
    return lineOf(text, offset);
  }

  limit(text: string): void {
    this.limits.add(`routes ${this.component}: ${text}`);
  }

  /**
   * Reads every function no code of the route files calls, `init` functions first as Go runs them, then every function
   * left unread (one named only as a value), with its parameters unbound.
   */
  run(): void {
    const callers = callersOf(this.pkgs);
    const assigners = this.assignments();
    this.relevant = this.relevantFunctions(callers, assigners);
    const all: Array<{ fn: Fn; pkg: Pkg; decl: FuncDecl }> = [];
    for (const pkg of this.pkgs) {
      for (const f of pkg.files) {
        for (const decl of f.go.funcs) {
          if (!decl.body) continue;
          all.push({ fn: { type: decl.type, body: decl.body, name: decl.name, file: f.file, ...(decl.recv ? { recv: decl.recv } : {}), start: decl.start }, pkg, decl });
        }
      }
    }
    const start = (r: (typeof all)[number]) => this.invoke({ k: "func", fn: r.fn, pkg: r.pkg, scope: undefined }, [], true);
    // Go runs every `init`, a package's after those of the packages it imports and in the order of its files' names
    // (go.dev/ref/spec, "Package initialization"), then `main` of a main package.
    const order = this.initOrder();
    const init = all
      .filter((r) => !r.decl.recv && r.decl.name === "init")
      .sort((a, b) => order.indexOf(a.pkg) - order.indexOf(b.pkg) || (a.fn.file < b.fn.file ? -1 : a.fn.file > b.fn.file ? 1 : a.fn.start - b.fn.start));
    const main = all.filter((r) => !r.decl.recv && r.decl.name === "main" && r.pkg.name === "main");
    init.forEach(start);
    main.forEach(start);
    for (const r of all) {
      if (init.includes(r) || main.includes(r) || (callers.get(r.decl)?.size ?? 0)) continue;
      this.epoch++;
      start(r);
    }
    // A function named only where atlas does not read a call to it (a value, a call on a value not traced): its callers
    // first, so that a function they pass a router reads it bound.
    for (;;) {
      const left = all.filter((r) => !this.invoked.has(this.fnKey(r.fn)));
      if (!left.length || this.exhausted) return;
      this.epoch++;
      const decls = new Set(left.map((r) => r.decl));
      start(left.find((r) => ![...(callers.get(r.decl) ?? [])].some((c) => c !== null && c !== r.decl && decls.has(c))) ?? left[0]!);
    }
  }

  /**
   * The functions that name one of the routers' packages, return a struct type of the route files' packages, or name
   * such a function: only these can make a router, register on one they did not get, or give back what one is held in.
   */
  private relevantFunctions(callers: Map<FuncDecl, Set<FuncDecl | null>>, assigners: Set<FuncDecl>): Set<number> {
    const out = new Set<FuncDecl>();
    const keyOf = new Map<FuncDecl, number>();
    for (const pkg of this.pkgs) {
      for (const f of pkg.files) {
        const libs = new Set([...f.imports].filter(([, path]) => [GIN, CHI, CHI_MIDDLEWARE, HTTP].includes(path)).map(([name]) => name));
        const dotted = f.dots.some((d) => [GIN, CHI, CHI_MIDDLEWARE, HTTP].includes(d));
        const toks = tokenize(f.text);
        for (const decl of f.go.funcs) {
          keyOf.set(decl, this.fnKey({ type: decl.type, name: decl.name, file: f.file, start: decl.start }));
          const returnsStruct = decl.type.results.some((r) => {
            const ref = this.typeRef(r.type, { pkg, imports: f.imports });
            return !!ref && ref.pkg.types.get(ref.name)?.type.k === "structtype";
          });
          const names = toks.some((t) => t.kind === "ident" && t.start >= decl.start && t.start < decl.end && libs.has(t.text));
          if (dotted || returnsStruct || names || assigners.has(decl)) out.add(decl);
        }
      }
    }
    // A function that names a relevant one is relevant too.
    for (let changed = true; changed; ) {
      changed = false;
      for (const [decl, by] of callers) {
        if (!out.has(decl)) continue;
        for (const c of by) {
          if (c && !out.has(c)) {
            out.add(c);
            changed = true;
          }
        }
      }
    }
    return new Set([...out].map((d) => keyOf.get(d)!));
  }

  /**
   * The functions that assign a package-level variable (`x = ...`, `pkg.X = ...`, `x++`), from their tokens, function
   * literals in them included; the variables a function other than `init` assigns are `mutable`.
   */
  private assignments(): Set<FuncDecl> {
    const out = new Set<FuncDecl>();
    const isAssign = (t: { kind: string; text: string }) =>
      t.kind === "op" && (t.text === "=" || t.text === "++" || t.text === "--" || (t.text.endsWith("=") && t.text.length > 1 && !["==", "!=", "<=", ">=", ":="].includes(t.text)));
    for (const pkg of this.pkgs) {
      for (const f of pkg.files) {
        const toks = tokenize(f.text);
        for (const decl of f.go.funcs) {
          if (!decl.body) continue;
          const init = !decl.recv && decl.name === "init";
          for (let i = 0; i < toks.length; i++) {
            const t = toks[i]!;
            if (t.start < decl.body.start || t.start >= decl.body.end || !isAssign(t)) continue;
            // The left side: back to the start of the statement, in parts between commas.
            const parts: Array<typeof toks> = [[]];
            for (let j = i - 1; j >= 0 && toks[j]!.start > decl.body.start; j--) {
              const u = toks[j]!;
              if (u.kind === ";" || u.kind === "keyword" || (u.kind === "op" && ["{", "}", "(", ")", "[", "]"].includes(u.text) && parts[0]!.length === 0)) break;
              if (u.kind === "op" && u.text === ",") parts.unshift([]);
              else parts[0]!.unshift(u);
            }
            for (const part of parts) {
              let target: { pkg: Pkg; name: string } | undefined;
              if (part.length === 1 && part[0]!.kind === "ident") target = { pkg, name: part[0]!.text };
              else if (part.length === 3 && part[0]!.kind === "ident" && part[1]!.text === "." && part[2]!.kind === "ident") {
                const other = this.byPath.get(f.imports.get(part[0]!.text) ?? "");
                if (other) target = { pkg: other, name: part[2]!.text };
              }
              if (!target || target.pkg.values.get(target.name)?.kind !== "var") continue;
              out.add(decl);
              if (!init) this.mutable.add(`${target.pkg.dir}\0${target.name}`);
            }
          }
        }
      }
    }
    return out;
  }

  /** The packages in the order Go initializes them: each after the packages of the route files it imports. */
  private initOrder(): Pkg[] {
    const out: Pkg[] = [];
    const seen = new Set<Pkg>();
    const visit = (p: Pkg) => {
      if (seen.has(p)) return;
      seen.add(p);
      for (const f of p.files) for (const path of [...f.imports.values(), ...f.dots]) {
        const dep = this.byPath.get(path);
        if (dep) visit(dep);
      }
      out.push(p);
    };
    this.pkgs.forEach(visit);
    return out;
  }

  private fnKey(fn: Fn): number {
    // A function is told apart by its file and where it starts; files are numbered by their place among the packages.
    let n = 0;
    for (const p of this.pkgs) for (const f of p.files) {
      if (f.file === fn.file) return n * 1e9 + fn.start;
      n++;
    }
    return -1;
  }

  private fileOf(pkg: Pkg, file: string) {
    return pkg.files.find((f) => f.file === file) ?? pkg.files[0]!;
  }

  /**
   * Reads a function's body with its parameters bound to the arguments of the call that reaches it (`root`: none, each
   * an unbound parameter), and gives the values it returns: each result where every `return` gives the same, else
   * unknown.
   */
  invoke(f: V & { k: "func" }, args: V[], root = false): V[] {
    const fn = f.fn;
    const resultCount = fn.type.results.reduce((n, r) => n + Math.max(1, r.names.length), 0);
    const unknowns = () => Array.from({ length: resultCount }, () => UNKNOWN);
    if (!fn.body) return unknowns();
    const key = this.fnKey(fn);
    if (this.stack.includes(key)) {
      if (this.relevant.has(key)) this.limit(`${this.at(fn.file, fn.start)} ${fn.name} calls itself; what the recursive call registers is not read`);
      return unknowns();
    }
    if (this.stack.length >= MAX_DEPTH || this.calls >= MAX_CALLS) {
      if (!this.exhausted) this.limit(`the calls between the functions of the route files go deeper or further than atlas follows (${MAX_DEPTH} deep, ${MAX_CALLS} in all); the routes registered beyond are not read`);
      this.exhausted = true;
      return unknowns();
    }
    this.calls++;
    this.invoked.add(key);
    this.stack.push(key);
    const file = this.fileOf(f.pkg, fn.file);
    const scope = new Scope(f.scope);
    const frame: Frame = { pkg: f.pkg, file: fn.file, text: file.text, imports: file.imports, dots: file.dots, returns: [], returned: false, fn: fn.name, named: [] };
    const unbound = (name: string, type: Expr | undefined): V => {
      // A struct of the route files' packages, its fields not set: what they hold is unknown, of the types they declare.
      const struct = type ? this.typeRef(type, frame) : undefined;
      if (struct && struct.pkg.types.get(struct.name)?.type.k === "structtype") return { k: "obj", type: struct, fields: new Map(), vague: `a ${struct.name} that no call of the route files passes`, untraced: true };
      const t = type ? this.routerType(type, frame) : undefined;
      const declared = Object.hasOwn(this.declared, fn.file) ? this.declared[fn.file] : undefined;
      if (declared !== undefined && t && t !== "handler") return this.synthetic(t, declared, fn.file, fn.start);
      return { k: "unknown", ...(t ? { type: t } : {}), why: `${name}, a parameter of ${fn.name} that no call of the route files passes a router`, untraced: true };
    };
    if (fn.recv) {
      const name = fn.recv.names[0]?.name;
      // A pointer receiver shares the struct it is called on; a value receiver gets a copy of it.
      const pointer = fn.recv.type.k === "unary" && fn.recv.type.op === "*";
      let recv = f.recv ?? unbound(name ?? "_", fn.recv.type);
      if (recv.k === "obj" && pointer && recv.byValue) {
        recv = { ...recv };
        delete recv.byValue;
      } else if (!pointer) recv = copied(recv, true);
      if (name && name !== "_") scope.vars.set(name, recv);
    }
    let i = 0;
    for (const p of fn.type.params) {
      const names = p.names.length ? p.names.map((n) => n.name) : ["_"];
      for (const name of names) {
        let v: V = p.variadic ? UNKNOWN : (args[i] ?? (root ? unbound(name, p.type) : UNKNOWN));
        if (v.k === "unknown" && !v.type) {
          const t = this.routerType(p.type, frame);
          if (t) v = { ...v, type: t };
        }
        if (name !== "_") scope.vars.set(name, copied(v));
        i++;
      }
    }
    // Named results start at their zero value: nil, which atlas holds as unknown of the declared type, or a struct
    // with no field set; a bare `return` gives what they hold then.
    for (const r of fn.type.results) {
      for (const n of r.names) {
        if (n.name === "_") continue;
        const ref = this.typeRef(r.type, frame);
        const t = this.routerType(r.type, frame);
        const zero: V = ref && r.type.k !== "unary" && ref.pkg.types.get(ref.name)?.type.k === "structtype" ? { k: "obj", type: ref, fields: new Map(), byValue: true } : t ? { k: "unknown", type: t } : UNKNOWN;
        scope.vars.set(n.name, zero);
      }
      if (r.names.length) frame.named.push(...r.names.map((n) => n.name));
    }
    try {
      this.block(fn.body.stmts, scope, frame);
    } finally {
      this.stack.pop();
    }
    const types = fn.type.results.flatMap((r) => Array.from({ length: Math.max(1, r.names.length) }, () => r.type));
    return Array.from({ length: resultCount }, (_, k) => {
      const first = frame.returns[0]?.[k];
      if (first && frame.returns.every((r) => same(r[k], first))) return copied(first);
      // Results that differ, or none read, are what the declared result type says they are.
      const t = types[k] ? this.routerType(types[k], frame) : undefined;
      const ref = types[k] ? this.typeRef(types[k], frame) : undefined;
      if (ref && ref.pkg.types.get(ref.name)?.type.k === "structtype") return { k: "obj", type: ref, fields: new Map(), vague: `a ${ref.name} ${fn.name} returns, which atlas does not settle` };
      return t ? { k: "unknown", type: t, why: `a router ${fn.name} returns, which atlas does not settle` } : UNKNOWN;
    });
  }

  /** A router `mounts` places a file's unbound router parameter under: one of the parameter's type, mounted at `path`. */
  private synthetic(t: RouterType, path: string, file: string, at: number): V {
    const lib: Lib = t === "gin" || t === "gin-engine" ? "gin" : t === "chi" ? "chi" : "mux";
    const r = this.newRouter(lib, file, at);
    r.declared = path;
    return { k: "router", r, base: "/" };
  }

  newRouter(lib: Lib, file: string, at: number): Router {
    const r: Router = { id: this.nextId++, lib, file, line: this.line(file, at), mounts: [], regs: [] };
    if (lib === "gin") r.tsr = true;
    if (Object.hasOwn(this.declared, file)) r.declared = this.declared[file];
    this.routers.push(r);
    return r;
  }

  /** The DefaultServeMux, which `http.Handle` and `http.HandleFunc` register on. */
  private muxDefault(file: string, at: number): Router {
    if (!this.defaultMux) {
      this.defaultMux = this.newRouter("mux", file, at);
      this.defaultMux.default = true;
    }
    return this.defaultMux;
  }

  block(stmts: Stmt[], scope: Scope, frame: Frame): void {
    for (const s of stmts) {
      if (frame.returned) return;
      this.stmt(s, scope, frame);
    }
  }

  /** Where a name a function assigns is bound: a scope, or the package's variables. */
  private binding(name: string, scope: Scope, frame: Frame): Map<string, V> | undefined {
    const sc = scope.find(name);
    if (sc) return sc.vars;
    if (frame.pkg.values.get(name)?.kind !== "var") return undefined;
    this.global(frame.pkg, name);
    return frame.pkg.globals;
  }

  /** What a branch may assign (see `assignedNames`): a name, or a field of the struct a name holds. */
  private slot(target: string, scope: Scope, frame: Frame): { get: () => V | undefined; set: (v: V | undefined) => void } | undefined {
    const dot = target.indexOf(".");
    if (dot < 0) {
      const vars = this.binding(target, scope, frame);
      return vars && { get: () => vars.get(target), set: (v) => v !== undefined && this.write(vars, target, v) };
    }
    const base = this.lookup(target.slice(0, dot), scope, frame, 0);
    if (base.k !== "obj") return undefined;
    const field = target.slice(dot + 1);
    return { get: () => base.fields.get(field), set: (v) => v !== undefined && this.write(base.fields, field, v) };
  }

  /**
   * Assigns a variable or a field, noting in the innermost journal open (a branch's or a loop body's) what it held
   * before, so that what the code there changes, in the functions it calls too, is known when the branches join.
   */
  private write(map: Map<string, V>, key: string, v: V): void {
    const top = this.journals[this.journals.length - 1];
    if (top) {
      const entries = top.get(map) ?? top.set(map, new Map()).get(map)!;
      if (!entries.has(key)) entries.set(key, map.get(key));
    }
    map.set(key, v);
  }

  /** Closes the innermost journal: what it noted counts for the one around it, where that had not noted it yet. */
  private closeJournal(): Journal {
    const j = this.journals.pop()!;
    const outer = this.journals[this.journals.length - 1];
    if (outer) {
      for (const [map, entries] of j) {
        const into = outer.get(map) ?? outer.set(map, new Map()).get(map)!;
        for (const [key, before] of entries) if (!into.has(key)) into.set(key, before);
      }
    }
    return j;
  }

  /**
   * Reads each branch from the same values, and keeps after them a variable or field every branch leaves at one value,
   * forgetting one they leave at different values; whatever the branch assigns counts, in the functions it calls too.
   */
  private branches(bodies: Array<(scope: Scope) => void>, exhaustive: boolean, scope: Scope, frame: Frame): void {
    const runs: Journal[] = [];
    this.conditional++;
    try {
      for (const body of bodies) {
        this.journals.push(new Map());
        try {
          body(new Scope(scope));
        } finally {
          frame.returned = false;
          const j = this.journals.pop()!;
          // What the branch left, then the values from before it, for the next branch.
          const after: Journal = new Map();
          for (const [map, entries] of j) {
            after.set(map, new Map([...entries.keys()].map((k) => [k, map.get(k)])));
            for (const [k, before] of entries) {
              if (before === undefined) map.delete(k);
              else map.set(k, before);
            }
          }
          runs.push(after);
        }
      }
    } finally {
      this.conditional--;
    }
    const keys = new Map<Map<string, V>, Set<string>>();
    for (const r of runs) for (const [map, entries] of r) for (const k of entries.keys()) (keys.get(map) ?? keys.set(map, new Set()).get(map)!).add(k);
    for (const [map, names] of keys) {
      for (const k of names) {
        const before = map.get(k);
        const values = runs.map((r) => (r.get(map)?.has(k) ? r.get(map)!.get(k) : before));
        if (!exhaustive) values.push(before);
        const kept = values[0];
        if (values.every((x) => (x === undefined && kept === undefined) || (x !== undefined && kept !== undefined && same(x, kept)))) {
          if (kept !== undefined && kept !== before) this.write(map, k, kept);
          continue;
        }
        const known = values.find((x) => x !== undefined);
        this.write(map, k, known === undefined ? UNKNOWN : forget(known));
      }
    }
  }

  stmt(s: Stmt, scope: Scope, frame: Frame): void {
    switch (s.k) {
      case "expr":
        this.evalAll(s.x, scope, frame, true);
        return;
      case "go":
        this.evalAll(s.call, scope, frame, true);
        return;
      case "decl":
        for (const spec of s.decl.specs) {
          if (s.decl.kind === "type") continue;
          const values = this.values(spec.values, spec.names.length, scope, frame);
          spec.names.forEach((n, i) => {
            if (n.name === "_") return;
            let v = values[i] ?? UNKNOWN;
            if (v.k === "unknown" && spec.type && this.httpServer(spec.type, frame)) v = { k: "builtin", pkg: HTTP, name: "Server" };
            if (v.k === "unknown" && spec.type) {
              const t = this.routerType(spec.type, frame);
              if (t) v = { k: "unknown", type: t };
            }
            scope.vars.set(n.name, copied(v));
          });
        }
        return;
      case "assign":
        return this.assign(s, scope, frame);
      case "block":
        this.block(s.block.stmts, new Scope(scope), frame);
        return;
      case "if": {
        const inner = new Scope(scope);
        if (s.init) this.stmt(s.init, inner, frame);
        this.evalAll(s.cond, inner, frame);
        const bodies = [(sc: Scope) => this.block(s.then.stmts, sc, frame)];
        if (s.else) bodies.push((sc: Scope) => this.stmt(s.else!, sc, frame));
        this.branches(bodies, !!s.else, inner, frame);
        return;
      }
      case "switch": {
        const inner = new Scope(scope);
        if (s.init) this.stmt(s.init, inner, frame);
        if (s.tag) this.stmt(s.tag, inner, frame);
        const exhaustive = s.clauses.some((c) => !c.exprs.length);
        // A case's expressions are evaluated as the switch reaches it, which it may not.
        const clause = (c: (typeof s.clauses)[number]) => (sc: Scope) => {
          for (const x of c.exprs) this.evalAll(x, sc, frame);
          this.block(c.body, sc, frame);
        };
        this.branches(s.clauses.map(clause), exhaustive, inner, frame);
        return;
      }
      case "for": {
        const inner = new Scope(scope);
        if (s.init) this.stmt(s.init, inner, frame);
        this.loop(s.body.stmts, s.post, inner, frame, () => {
          if (s.cond) this.evalAll(s.cond, inner, frame);
        });
        return;
      }
      case "range": {
        const x = this.eval(s.x, scope, frame);
        const inner = new Scope(scope);
        const bind = (key: V, value: V) => {
          const [k, v] = s.lhs;
          for (const [target, val] of [[k, key], [v, value]] as Array<[Expr | undefined, V]>) {
            if (!target || (target.k === "ident" && target.name === "_")) continue;
            if (s.define && target.k === "ident") inner.vars.set(target.name, val);
            else this.store(target, val, inner, frame);
          }
        };
        if (x.k === "strs" && x.values.length <= MAX_RANGE) {
          const names = assignedNames(s.body.stmts);
          x.values.forEach((value) => {
            bind(UNKNOWN, { k: "str", value });
            this.block(s.body.stmts, new Scope(inner), frame);
            frame.returned = false;
          });
          this.forgetAll(names, scope, frame);
          return;
        }
        bind(UNKNOWN, UNKNOWN);
        this.loop(s.body.stmts, undefined, inner, frame);
        return;
      }
      case "return": {
        const values = !s.results.length && frame.named.length ? frame.named.map((n) => (n === "_" ? UNKNOWN : this.lookup(n, scope, frame, s.start))) : this.values(s.results, s.results.length, scope, frame);
        frame.returns.push(values);
        frame.returned = true;
        return;
      }
      case "labeled":
        this.stmt(s.stmt, scope, frame);
        return;
      default:
        return;
    }
  }

  /** A loop's body, read once with every name it assigns unknown, as each pass may find it changed. */
  /**
   * A loop's body and post statement, read with every name or field they assign unknown, as each pass may find it
   * changed; where a pass changes what the code it calls assigns, that is made unknown and the body read again.
   */
  private loop(body: Stmt[], post: Stmt | undefined, scope: Scope, frame: Frame, before?: () => void): void {
    const all = post ? [...body, post] : body;
    const names = assignedNames(all);
    this.forgetAll(names, scope, frame);
    before?.();
    const pass = () => {
      this.conditional++;
      this.journals.push(new Map());
      try {
        this.block(body, new Scope(scope), frame);
        frame.returned = false;
        if (post) this.stmt(post, scope, frame);
      } finally {
        this.conditional--;
      }
      return this.closeJournal();
    };
    const changed = (j: Journal) => [...j].flatMap(([map, entries]) => [...entries].filter(([k, b]) => !(b !== undefined && map.get(k) !== undefined && same(b, map.get(k)))).map(([k]) => ({ map, k })));
    const first = changed(pass());
    if (first.length) {
      for (const { map, k } of first) if (map.has(k)) this.write(map, k, forget(map.get(k)!));
      for (const { map, k } of changed(pass())) if (map.has(k)) this.write(map, k, forget(map.get(k)!));
    }
    frame.returned = false;
    this.forgetAll(names, scope, frame);
  }

  /** Makes each name or field a loop may assign unknown, as each pass may find it changed. */
  private forgetAll(names: Set<string>, scope: Scope, frame: Frame): void {
    for (const n of names) {
      const slot = this.slot(n, scope, frame);
      const v = slot?.get();
      if (slot && v !== undefined) slot.set(forget(v));
    }
  }

  /** The values of an expression list for `count` names: one each, or a call's results spread over them. */
  private values(exprs: Expr[], count: number, scope: Scope, frame: Frame): V[] {
    if (exprs.length === 1 && count > 1) {
      const all = this.evalAll(exprs[0]!, scope, frame);
      return Array.from({ length: count }, (_, i) => all[i] ?? UNKNOWN);
    }
    return exprs.map((e) => this.eval(e, scope, frame));
  }

  private assign(s: Stmt & { k: "assign" }, scope: Scope, frame: Frame): void {
    if (s.op !== ":=" && s.op !== "=") {
      // `x += "/y"` (or `s.path += "/y"`) keeps a string read where both sides are; any other operator leaves what it
      // assigns unknown.
      const target = s.lhs[0];
      const right = s.rhs[0] ? this.eval(s.rhs[0], scope, frame) : UNKNOWN;
      if (target) {
        const left = this.eval(target, scope, frame);
        const v: V = s.op === "+=" && left.k === "str" && right.k === "str" ? { k: "str", value: left.value + right.value } : UNKNOWN;
        this.store(target, v, scope, frame);
      }
      return;
    }
    const values = this.values(s.rhs, s.lhs.length, scope, frame);
    s.lhs.forEach((target, i) => {
      const v = values[i] ?? UNKNOWN;
      if (target.k === "ident" && target.name === "_") return;
      // `:=` declares the names its scope does not hold yet, and assigns the others (go.dev/ref/spec, "Short variable declarations").
      if (s.op === ":=" && target.k === "ident" && !scope.vars.has(target.name)) scope.vars.set(target.name, copied(v));
      else this.store(target, v, scope, frame);
    });
  }

  /** Assigns a value to a name, a package-level variable, a struct field, or a router's setting. */
  private store(target: Expr, given: V, scope: Scope, frame: Frame): void {
    const v = copied(given);
    if (target.k === "paren") return this.store(target.x, v, scope, frame);
    if (target.k === "ident") {
      const sc = scope.find(target.name);
      if (sc) this.write(sc.vars, target.name, v);
      else if (frame.pkg.values.get(target.name)?.kind === "var") this.setGlobal(frame.pkg, target.name, v);
      return;
    }
    if (target.k === "unary" && target.op === "*") return this.store(target.x, v, scope, frame);
    if (target.k === "index") {
      this.eval(target.x, scope, frame);
      return this.escape(v, frame, target.start);
    }
    if (target.k !== "sel") return;
    const x = this.eval(target.x, scope, frame);
    if (x.k === "obj") {
      this.write(x.fields, target.name, v);
      return;
    }
    if (x.k === "router" && x.r.lib === "gin" && target.name === "RedirectTrailingSlash") {
      if (this.conditional) {
        x.r.tsr = null;
        this.limit(`${this.at(frame.file, target.start)} sets Gin's RedirectTrailingSlash in a branch or loop that may not run; whether the engine redirects a request whose trailing / differs is not read`);
      } else if (v.k === "bool") x.r.tsr = v.value;
      else {
        x.r.tsr = null;
        this.limit(`${this.at(frame.file, target.start)} sets Gin's RedirectTrailingSlash to a value the file does not spell out; whether the engine redirects a request whose trailing / differs is not read`);
      }
      return;
    }
    if (x.k === "unknown") return this.escape(v, frame, target.start);
    if (x.k === "builtin" && x.pkg === HTTP && x.name === "Server") return;
    if (x.k === "pkg") {
      const pkg = this.byPath.get(x.path);
      if (pkg?.values.get(target.name)?.kind === "var") this.setGlobal(pkg, target.name, v);
    }
  }
  /** The router type a declared type names, through the file's imports. */
  routerType(type: Expr, frame: Pick<Frame, "imports">): RouterType | undefined {
    if (type.k === "unary" && type.op === "*") return this.routerType(type.x, frame);
    if (type.k === "paren") return this.routerType(type.x, frame);
    if (type.k !== "sel" || type.x.k !== "ident") return undefined;
    const path = frame.imports.get(type.x.name);
    if (path === GIN) return type.name === "Engine" ? "gin-engine" : ["RouterGroup", "IRouter", "IRoutes"].includes(type.name) ? "gin" : undefined;
    if (path === CHI) return ["Router", "Mux", "Routes"].includes(type.name) ? "chi" : undefined;
    if (path === HTTP) return type.name === "ServeMux" ? "mux" : type.name === "Handler" ? "handler" : undefined;
    return undefined;
  }

  /** The value of a package-level variable or constant, read once from its declaration. */
  /**
   * The value of a package-level variable or constant: its declaration's, read once, or the last one the code read
   * assigns. A variable a function other than `init` assigns may have been changed before a function another package
   * calls runs, so there it is unknown unless that call has assigned it itself.
   */
  private global(pkg: Pkg, name: string): V {
    if (!pkg.globals.has(name)) this.initial(pkg, name);
    if (this.epoch !== 0 && this.mutable.has(`${pkg.dir}\0${name}`) && pkg.epochs.get(name) !== this.epoch) {
      pkg.globals.set(name, forget(pkg.globals.get(name)!));
      pkg.epochs.set(name, this.epoch);
    }
    return pkg.globals.get(name)!;
  }

  /** Assigns a package-level variable. */
  private setGlobal(pkg: Pkg, name: string, v: V): void {
    this.global(pkg, name);
    this.write(pkg.globals, name, v);
    pkg.epochs.set(name, this.epoch);
  }

  private initial(pkg: Pkg, name: string): void {
    const decl = pkg.values.get(name)!;
    pkg.globals.set(name, UNKNOWN);
    const file = this.fileOf(pkg, decl.file);
    const frame: Frame = { pkg, file: decl.file, text: file.text, imports: file.imports, dots: file.dots, returns: [], returned: false, fn: name, named: [] };
    let v: V = UNKNOWN;
    if (decl.value) {
      if (decl.count > 1 && decl.value.k === "call") v = this.evalAll(decl.value, new Scope(), frame)[decl.index] ?? UNKNOWN;
      else v = this.eval(decl.value, new Scope(), frame);
    }
    if (v.k === "unknown" && decl.type) {
      const t = this.routerType(decl.type, frame);
      if (t) v = { k: "unknown", type: t };
    }
    if (pkg.globals.get(name) === UNKNOWN) pkg.globals.set(name, v);
    pkg.epochs.set(name, 0);
  }

  /** A name of a package another file imports: a module package's function or value, or a library's. */
  private member(path: string, name: string, frame: Frame, at: number): V {
    if (path === HTTP) {
      if (Object.hasOwn(HTTP_METHODS, name)) return { k: "str", value: HTTP_METHODS[name]! };
      if (name === "DefaultServeMux") return { k: "router", r: this.muxDefault(frame.file, at), base: "" };
    }
    const pkg = this.byPath.get(path);
    if (pkg) {
      const f = pkg.funcs.get(name);
      if (f) return { k: "func", fn: { type: f.decl.type, ...(f.decl.body ? { body: f.decl.body } : {}), name: f.decl.name, file: f.file, start: f.decl.start }, pkg, scope: undefined };
      if (pkg.values.has(name)) return this.global(pkg, name);
      if (pkg.types.has(name)) return { k: "builtin", pkg: path, name };
      return UNKNOWN;
    }
    return { k: "builtin", pkg: path, name };
  }

  /** The value a name has: a local, a package-level function or value, an imported package, or a dot-imported name. */
  private lookup(name: string, scope: Scope, frame: Frame, at: number): V {
    const sc = scope.find(name);
    if (sc) return sc.vars.get(name)!;
    if (name === "true" || name === "false") return { k: "bool", value: name === "true" };
    const pkg = frame.pkg;
    const f = pkg.funcs.get(name);
    if (f) return { k: "func", fn: { type: f.decl.type, ...(f.decl.body ? { body: f.decl.body } : {}), name: f.decl.name, file: f.file, start: f.decl.start }, pkg, scope: undefined };
    if (pkg.values.has(name)) return this.global(pkg, name);
    if (pkg.types.has(name)) return { k: "builtin", pkg: pkg.path ?? pkg.dir, name };
    const path = frame.imports.get(name);
    if (path !== undefined) return { k: "pkg", path };
    for (const dot of frame.dots) {
      const v = this.member(dot, name, frame, at);
      if (v.k !== "unknown" && !(v.k === "builtin" && !this.byPath.has(dot) && ![HTTP, GIN, CHI, CHI_MIDDLEWARE].includes(dot))) return v;
    }
    return UNKNOWN;
  }

  eval(e: Expr, scope: Scope, frame: Frame): V {
    return this.evalAll(e, scope, frame)[0] ?? UNKNOWN;
  }

  /** Every value an expression gives: a call's results, or the one value of any other expression. */
  evalAll(e: Expr, scope: Scope, frame: Frame, statement = false): V[] {
    switch (e.k) {
      case "ident":
        return [this.lookup(e.name, scope, frame, e.start)];
      case "string":
        return [e.value === undefined ? UNKNOWN : { k: "str", value: e.value }];
      case "paren":
        return [this.eval(e.x, scope, frame)];
      case "unary": {
        const x = this.eval(e.x, scope, frame);
        // `&s` points to the struct `s` holds, whose fields it shares; `*p` is the struct a pointer points to.
        if (x.k === "obj" && e.op === "&") {
          const pointer = { ...x };
          delete pointer.byValue;
          return [pointer];
        }
        if (x.k === "obj" && e.op === "*") return [{ ...x, byValue: true }];
        return [e.op === "&" || e.op === "*" ? x : UNKNOWN];
      }
      case "binary": {
        const x = this.eval(e.x, scope, frame);
        const y = this.eval(e.y, scope, frame);
        return [e.op === "+" && x.k === "str" && y.k === "str" ? { k: "str", value: x.value + y.value } : UNKNOWN];
      }
      case "sel":
        return [this.select(e, scope, frame)];
      case "call":
        return this.call(e, scope, frame, statement);
      case "composite":
        return [this.composite(e, scope, frame)];
      case "func":
        return [{ k: "func", fn: { type: e.type, body: e.body, name: "a function literal", file: frame.file, start: e.start }, pkg: frame.pkg, scope }];
      case "index": {
        // A generic function's instantiation is the function; an element of a value is not read.
        const x = this.eval(e.x, scope, frame);
        for (const i of e.indices) this.eval(i, scope, frame);
        return [x.k === "func" ? x : UNKNOWN];
      }
      case "assert":
        return [this.eval(e.x, scope, frame)];
      case "slice":
        this.eval(e.x, scope, frame);
        for (const b of e.bounds) this.eval(b, scope, frame);
        return [UNKNOWN];
      case "kv":
        return [this.eval(e.value, scope, frame)];
      default:
        return [UNKNOWN];
    }
  }

  /** `x.name`: a package's member, a struct's field or method, or a router's method or setting. */
  private select(e: Expr & { k: "sel" }, scope: Scope, frame: Frame): V {
    const x = this.eval(e.x, scope, frame);
    if (x.k === "pkg") return this.member(x.path, e.name, frame, e.start);
    if (x.k === "obj") return this.field(x, e.name, frame);
    if (x.k === "router") return { k: "method", recv: x, name: e.name };
    return UNKNOWN;
  }

  /** A struct's field, its method as a value, or one an embedded field promotes. */
  private field(x: V & { k: "obj" }, name: string, frame: Frame, depth = 0): V {
    if (x.fields.has(name)) return x.fields.get(name)!;
    const m = x.type.pkg.methods.get(`${x.type.name}.${name}`);
    if (m) {
      const recv = m.decl.recv!;
      return { k: "func", fn: { type: m.decl.type, ...(m.decl.body ? { body: m.decl.body } : {}), name: `${x.type.name}.${name}`, file: m.file, recv, start: m.decl.start }, pkg: x.type.pkg, scope: undefined, recv: x };
    }
    const decl = x.type.pkg.types.get(x.type.name);
    if (decl?.type.k !== "structtype" || depth > 8) return UNKNOWN;
    for (const f of decl.type.fields) {
      if (!f.names.length) {
        const embedded = embeddedName(f.type);
        const inner = embedded ? x.fields.get(embedded) : undefined;
        if (inner?.k === "obj") {
          const v = this.field(inner, name, frame, depth + 1);
          if (v.k !== "unknown") return v;
        }
        if (inner?.k === "router") return { k: "method", recv: inner, name };
      } else if (f.names.some((n) => n.name === name)) {
        const file = this.fileOf(x.type.pkg, decl.file);
        const t = this.routerType(f.type, { imports: file.imports });
        if (!t) return UNKNOWN;
        if (x.vague) return { k: "unknown", type: t, why: `the field ${name} of ${x.vague}`, ...(x.untraced ? { untraced: true as const } : {}) };
        return { k: "unknown", type: t, why: `the field ${name} of ${x.type.name}, which no code of the route files sets to a router` };
      }
    }
    return UNKNOWN;
  }

  /** A composite literal: a struct of the route files' packages, a list of strings, or a value not read. */
  private composite(e: Expr & { k: "composite" }, scope: Scope, frame: Frame): V {
    const values = e.elts.map((el) => ({ key: el.key, value: this.eval(el.value, scope, frame) }));
    const type = e.type;
    // A router put in a value atlas does not follow (a map, a slice, another package's struct) may be mounted from there.
    const lost = () => {
      for (const v of values) this.escape(v.value, frame, e.start);
      return UNKNOWN;
    };
    if (type?.k === "arraytype") return values.every((v) => v.value.k === "str" && !v.key) ? { k: "strs", values: values.map((v) => (v.value as { value: string }).value) } : lost();
    // net/http's Server serves its Handler at the root, as a router nothing mounts is.
    if (type && this.httpServer(type, frame)) return { k: "builtin", pkg: HTTP, name: "Server" };
    const ref = type ? this.typeRef(type, frame) : undefined;
    if (!ref) return lost();
    const decl = ref.pkg.types.get(ref.name);
    if (decl?.type.k !== "structtype") return lost();
    const fields = new Map<string, V>();
    const order = decl.type.fields.flatMap((f) => (f.names.length ? f.names.map((n) => n.name) : [embeddedName(f.type) ?? "_"]));
    values.forEach((v, i) => {
      const name = v.key?.k === "ident" ? v.key.name : v.key ? undefined : order[i];
      if (name) fields.set(name, copied(v.value));
    });
    return { k: "obj", type: ref, fields, byValue: true };
  }

  /** The struct type a type expression names in the route files' packages. */
  private typeRef(type: Expr, frame: Pick<Frame, "pkg" | "imports">): TypeRef | undefined {
    if (type.k === "unary" && type.op === "*") return this.typeRef(type.x, frame);
    if (type.k === "ident" && frame.pkg.types.has(type.name)) return { pkg: frame.pkg, name: type.name };
    if (type.k === "sel" && type.x.k === "ident") {
      const pkg = this.byPath.get(frame.imports.get(type.x.name) ?? "");
      if (pkg?.types.has(type.name)) return { pkg, name: type.name };
    }
    if (type.k === "index") return this.typeRef(type.x, frame);
    return undefined;
  }

  /** A call: a router's method, a library's function, a function of the route files read with its arguments bound. */
  private call(e: Expr & { k: "call" }, scope: Scope, frame: Frame, statement: boolean): V[] {
    const fnExpr = e.fn;
    let callee: V;
    if (fnExpr.k === "sel") {
      const recv = this.eval(fnExpr.x, scope, frame);
      if (recv.k === "router") return [this.routerCall(recv, fnExpr.name, e, scope, frame)];
      if (recv.k === "unknown") return [this.unknownCall(recv, fnExpr, e, scope, frame)];
      callee = recv.k === "pkg" ? this.member(recv.path, fnExpr.name, frame, fnExpr.start) : recv.k === "obj" ? this.field(recv, fnExpr.name, frame) : UNKNOWN;
      if (callee.k === "unknown" && recv.k === "obj" && callee.type) return [this.unknownCall(callee, fnExpr, e, scope, frame)];
    } else callee = this.eval(fnExpr, scope, frame);
    if (callee.k === "method") return [this.routerCall(callee.recv, callee.name, e, scope, frame)];
    if (callee.k === "builtin") return this.builtinCall(callee, e, scope, frame, statement);
    const args = e.args.map((a) => this.eval(a, scope, frame));
    if (callee.k === "func") {
      // A function that touches no router, given none, gives nothing a route depends on: it is not read for this call.
      const carries = (v: V) => v.k === "router" || v.k === "obj" || v.k === "func" || v.k === "handler" || (v.k === "unknown" && !!v.type);
      if (callee.fn.name !== "a function literal" && !this.relevant.has(this.fnKey(callee.fn)) && !args.some(carries) && !(callee.recv && carries(callee.recv))) {
        return callee.fn.type.results.flatMap((r) => Array.from({ length: Math.max(1, r.names.length) }, () => UNKNOWN));
      }
      return this.invoke(callee, e.ellipsis ? args.slice(0, -1) : args);
    }
    // Go's `append` puts a router in a slice, which atlas does not follow.
    if (fnExpr.k === "ident" && fnExpr.name === "append") args.forEach((a) => this.escape(a, frame, e.start));
    this.literals(args, `${frame.text.slice(fnExpr.start, fnExpr.end)}`);
    return [UNKNOWN];
  }

  /** The function literals passed to a function atlas does not read, read once with their parameters unbound. */
  private literals(args: V[], callee: string): void {
    for (const a of args) {
      if (a.k !== "func" || a.fn.name !== "a function literal") continue;
      this.invoke({ ...a, fn: { ...a.fn, name: `a function literal passed to ${callee}` } }, []);
    }
  }

  /** The text of a string argument, recording where a literal one is so that it is not read as a request; undefined when not read. */
  private text(e: Expr | undefined, scope: Scope, frame: Frame): string | undefined {
    if (!e) return undefined;
    const v = this.eval(e, scope, frame);
    if (v.k !== "str") return undefined;
    // The literals the path is written with here (`"/api" + "/orders"`) are the registration's, not requests; a
    // constant's literal, written elsewhere, may be a client's as well, so it is left to be read.
    const literals = (x: Expr): void => {
      if (x.k === "string") this.spans.push({ file: frame.file, start: x.start, end: x.end });
      else if (x.k === "paren") literals(x.x);
      else if (x.k === "binary" && x.op === "+") {
        literals(x.x);
        literals(x.y);
      }
    };
    literals(e);
    return v.value;
  }

  private source(e: Expr | undefined, frame: Frame): string {
    return e ? frame.text.slice(e.start, e.end).replace(/\s+/g, " ") : "nothing";
  }

  private reg(r: Router, path: string, methods: string[] | "*", frame: Frame, at: number, extra: Partial<Reg> = {}): void {
    r.regs.push({ router: r, path, methods, file: frame.file, line: lineOf(frame.text, at), ...extra });
  }

  /** Where a method's name is written in a call, for the line a route is registered at. */
  private nameAt(e: Expr & { k: "call" }): number {
    return e.fn.k === "sel" ? e.fn.end - e.fn.name.length : e.start;
  }

  private routerCall(recv: V & { k: "router" }, name: string, e: Expr & { k: "call" }, scope: Scope, frame: Frame): V {
    this.handled.add(`${frame.file}:${e.start}`);
    if (recv.r.lib === "gin") return this.ginCall(recv, name, e, scope, frame);
    if (recv.r.lib === "chi") return this.chiCall(recv, name, e, scope, frame);
    return this.muxCall(recv, name, e, scope, frame);
  }

  /** A path argument not spelled out: the registration is not read. */
  private unreadPath(what: string, arg: Expr | undefined, frame: Frame, at: number): void {
    this.limit(`${this.at(frame.file, at)} registers ${what} at a path the file does not spell out (${this.source(arg, frame)}); it is not read`);
  }

  /** Gin's RouterGroup (routergroup.go): each registration returns the group, the engine for the engine's own. */
  private ginCall(recv: V & { k: "router" }, name: string, e: Expr & { k: "call" }, scope: Scope, frame: Frame): V {
    const at = this.nameAt(e);
    const r = recv.r;
    const register = (pathArg: Expr | undefined, methods: string[] | "*", extra: Partial<Reg> = {}, join: (p: string) => string = (p) => p) => {
      const what = methods === "*" ? "a route for any method" : `a ${methods.join(" and ")} route`;
      const path = this.text(pathArg, scope, frame);
      if (path === undefined) return this.unreadPath(what, pathArg, frame, at);
      if (recv.base === undefined) return this.limit(`${this.at(frame.file, at)} registers ${what} ${path} on a group whose path is not read; it is not read`);
      if ((extra.convention && /[:*]/.test(path))) return this.limit(`${this.at(frame.file, at)} serves files at ${path}, whose : or * Gin refuses ("URL parameters can not be used when serving a static file"); it is not read`);
      this.reg(r, ginJoin(recv.base, join(path)), methods, frame, at, extra);
    };
    if (GIN_VERBS.has(name)) {
      register(e.args[0], [name]);
      for (const a of e.args.slice(1)) this.eval(a, scope, frame);
      return recv;
    }
    const args = (from: number) => e.args.slice(from).forEach((a) => this.eval(a, scope, frame));
    switch (name) {
      case "Handle": {
        const method = this.text(e.args[0], scope, frame);
        // Gin panics on a method that is not upper-case letters (`regEnLetter`).
        if (method === undefined || !/^[A-Z]+$/.test(method)) this.limit(`${this.at(frame.file, at)} registers a route with a method ${method === undefined ? `the file does not spell out (${this.source(e.args[0], frame)})` : `Gin refuses (${JSON.stringify(method)})`}; it is not read`);
        else register(e.args[1], [method]);
        args(2);
        return recv;
      }
      case "Any":
        register(e.args[0], "*");
        args(1);
        return recv;
      case "Match": {
        const list = e.args[0] ? this.eval(e.args[0], scope, frame) : UNKNOWN;
        if (list.k !== "strs" || !list.values.every((m) => /^[A-Z]+$/.test(m))) this.limit(`${this.at(frame.file, at)} registers a route with methods the file does not spell out (${this.source(e.args[0], frame)}); it is not read`);
        else register(e.args[1], [...new Set(list.values)]);
        args(2);
        return recv;
      }
      case "Group": {
        const path = this.text(e.args[0], scope, frame);
        args(1);
        if (path === undefined) this.limit(`${this.at(frame.file, at)} makes a group at a path the file does not spell out (${this.source(e.args[0], frame)}); its routes are not read`);
        return { k: "router", r, base: path === undefined || recv.base === undefined ? undefined : ginJoin(recv.base, path) };
      }
      case "Static":
      case "StaticFS":
        register(e.args[0], ["GET", "HEAD"], { implicit: true, convention: "gin static" }, (p) => goJoin(p, "/*filepath"));
        args(1);
        return recv;
      case "StaticFile":
      case "StaticFileFS":
        register(e.args[0], ["GET", "HEAD"], { implicit: true, convention: "gin static" });
        args(1);
        return recv;
      case "Use":
      case "Handler":
        args(0);
        return recv;
      default:
        args(0);
        return UNKNOWN;
    }
  }

  /** chi's Mux (mux.go). */
  private chiCall(recv: V & { k: "router" }, name: string, e: Expr & { k: "call" }, scope: Scope, frame: Frame): V {
    const at = this.nameAt(e);
    const r = recv.r;
    const rest = (from: number) => e.args.slice(from).map((a) => this.eval(a, scope, frame));
    const register = (pathArg: Expr | undefined, methods: string[] | "*", given?: string) => {
      const what = methods === "*" ? "a route for any method" : `a ${methods.join(" and ")} route`;
      const path = given ?? this.text(pathArg, scope, frame);
      if (path === undefined) return this.unreadPath(what, pathArg, frame, at);
      this.reg(r, path, methods, frame, at);
    };
    if (Object.hasOwn(CHI_VERBS, name)) {
      register(e.args[0], [CHI_VERBS[name]!]);
      rest(1);
      return UNKNOWN;
    }
    switch (name) {
      case "Method":
      case "MethodFunc": {
        const method = this.text(e.args[0], scope, frame);
        if (method === undefined) this.limit(`${this.at(frame.file, at)} registers a route with a method the file does not spell out (${this.source(e.args[0], frame)}); it is not read`);
        else register(e.args[1], [method.toUpperCase()]);
        rest(2);
        return UNKNOWN;
      }
      case "Handle":
      case "HandleFunc": {
        const pattern = this.text(e.args[0], scope, frame);
        rest(1);
        if (pattern === undefined) return this.unreadPath("a route", e.args[0], frame, at), UNKNOWN;
        // chi 5.0 to 5.2.2 split `METHOD /path` at its first space; later ones at a space or tab, trimming those after.
        const space = pattern.search(/[ \t]/);
        if (space < 0) register(undefined, "*", pattern);
        else if (/^[^ \t]+ \/[^ \t]*$/.test(pattern)) register(undefined, [pattern.slice(0, space).toUpperCase()], pattern.slice(space + 1));
        else this.limit(`${this.at(frame.file, at)} registers ${JSON.stringify(pattern)}, which chi versions split into a method and a path differently; it is not read`);
        return UNKNOWN;
      }
      case "Route": {
        const pattern = this.text(e.args[0], scope, frame);
        const sub = this.newRouter("chi", frame.file, at);
        this.mount(sub, r, pattern, "chi", frame, at, e.args[0]);
        const fn = e.args[1] ? this.eval(e.args[1], scope, frame) : UNKNOWN;
        if (fn.k === "func") this.invoke(fn, [{ k: "router", r: sub, base: "" }]);
        else this.limit(`${this.at(frame.file, at)} routes ${pattern ?? this.source(e.args[0], frame)} to a function atlas does not read (${this.source(e.args[1], frame)}); its routes are not read`);
        return { k: "router", r: sub, base: "" };
      }
      case "Group": {
        const inline: V = { ...recv, inline: true };
        const fn = e.args[0] ? this.eval(e.args[0], scope, frame) : UNKNOWN;
        if (fn.k === "func") this.invoke(fn, [inline]);
        else if (!(e.args[0]?.k === "ident" && e.args[0].name === "nil")) this.limit(`${this.at(frame.file, at)} groups routes in a function atlas does not read (${this.source(e.args[0], frame)}); its routes are not read`);
        return inline;
      }
      case "With":
        rest(0);
        return { ...recv, inline: true };
      case "Use": {
        for (const a of e.args) {
          const v = this.eval(a, scope, frame);
          // An inline router's middlewares wrap each route's handler, after chi has found the route (mux.go `handle`).
          if (recv.inline || v.k !== "builtin" || v.pkg !== CHI_MIDDLEWARE) continue;
          if (v.name === "StripSlashes" || v.name === "RedirectSlashes") (r.rewrites ??= []).push(v.name);
          else if (v.name === "GetHead") r.headByGet = true;
          else if (["URLFormat", "StripPrefix", "PathRewrite"].includes(v.name)) (r.pathRewrites ??= []).push(this.source(a, frame));
        }
        return UNKNOWN;
      }
      case "Mount": {
        const pattern = this.text(e.args[0], scope, frame);
        const h = e.args[1] ? this.eval(e.args[1], scope, frame) : UNKNOWN;
        if (h.k === "router" && h.r.lib === "chi") this.mount(h.r, r, pattern, "chi", frame, at, e.args[0]);
        else if (h.k === "router" || (h.k === "handler" && h.strip?.inner.k === "router")) {
          this.escapeHandler(h, frame, e.start);
          this.limit(`${this.at(frame.file, at)} mounts ${this.source(e.args[1], frame)}, which is not a chi router and is handed the request's whole path; its routes are not read`);
        } else if (h.k === "handler" || h.k === "func") {
          if (pattern === undefined) this.unreadPath("a handler for any method", e.args[0], frame, at);
          else this.reg(r, pattern, "*", frame, at, { mountAll: true, ...(h.k === "handler" && (h.files || h.strip?.inner.k === "handler" && h.strip.inner.files) ? { implicit: true, convention: "net/http FileServer" } : {}) });
        } else this.limit(`${this.at(frame.file, at)} mounts ${this.source(e.args[1], frame)} at ${pattern ?? this.source(e.args[0], frame)}, which atlas does not trace to a router or handler; what it serves is not read`);
        rest(2);
        return UNKNOWN;
      }
      default:
        rest(0);
        return UNKNOWN;
    }
  }

  /** net/http's ServeMux (server.go): `Handle` and `HandleFunc`. */
  private muxCall(recv: V & { k: "router" }, name: string, e: Expr & { k: "call" }, scope: Scope, frame: Frame): V {
    const args = e.args.map((a, i) => (i === 0 ? UNKNOWN : this.eval(a, scope, frame)));
    if (name === "Handle" || name === "HandleFunc") this.muxRegister(recv.r, e, args[1] ?? UNKNOWN, scope, frame);
    return UNKNOWN;
  }

  private muxRegister(r: Router, e: Expr & { k: "call" }, h: V, scope: Scope, frame: Frame): void {
    const at = this.nameAt(e);
    const pattern = this.text(e.args[0], scope, frame);
    // A router served where atlas does not read is served nowhere atlas knows: not at the root either.
    if (pattern === undefined) {
      this.escapeHandler(h, frame, e.start);
      return this.unreadPath("a pattern", e.args[0], frame, at);
    }
    if (h.k === "handler" && h.strip && h.strip.inner.k === "router") return this.mount(h.strip.inner.r, r, h.strip.prefix, "strip", frame, at, e.args[0], pattern);
    if (h.k === "router") {
      if (pattern === "/") return this.mount(h.r, r, "", "root", frame, at, e.args[0], pattern);
      this.escapeHandler(h, frame, e.start);
      return this.limit(`${this.at(frame.file, at)} serves ${this.source(e.args[1], frame)} at ${JSON.stringify(pattern)} without http.StripPrefix, so it is handed the request's whole path; its routes are not read`);
    }
    const files = h.k === "handler" && (h.files || (h.strip?.inner.k === "handler" && h.strip.inner.files));
    this.reg(r, pattern, "*", frame, at, files ? { implicit: true, convention: "net/http FileServer" } : {});
  }

  /** Whether a type is net/http's `Server` (or a pointer to one). */
  private httpServer(type: Expr, frame: Pick<Frame, "imports">): boolean {
    if (type.k === "unary" && type.op === "*") return this.httpServer(type.x, frame);
    return type.k === "sel" && type.x.k === "ident" && frame.imports.get(type.x.name) === HTTP && type.name === "Server";
  }

  /** `escape` for a router a handler is, or serves under `http.StripPrefix`. */
  private escapeHandler(h: V, frame: Frame, at: number): void {
    this.escape(h.k === "handler" && h.strip ? h.strip.inner : h, frame, at);
  }

  /** Notes where a router is put in a value atlas does not follow, from which it may be mounted anywhere. */
  private escape(v: V, frame: Frame, at: number): void {
    if (v.k === "router" && !v.r.escaped) v.r.escaped = `${frame.file}:${lineOf(frame.text, at)}`;
  }

  /** Mounts a router on another, under a path read or not. */
  private mount(child: Router, parent: Router, prefix: string | undefined, how: Mount["how"], frame: Frame, at: number, arg: Expr | undefined, pattern?: string): void {
    if (prefix === undefined) this.limit(`${this.at(frame.file, at)} mounts a router at a path the file does not spell out (${this.source(arg, frame)}); its routes are not read`);
    child.mounts.push({ parent, prefix, how, file: frame.file, line: lineOf(frame.text, at), ...(pattern !== undefined ? { pattern } : {}) });
  }

  /** A call of a library function, or of a type of the route files' packages as a conversion. */
  private builtinCall(callee: V & { k: "builtin" }, e: Expr & { k: "call" }, scope: Scope, frame: Frame, statement: boolean): V[] {
    const at = this.nameAt(e);
    const { pkg, name } = callee;
    if (pkg === HTTP && (name === "Handle" || name === "HandleFunc")) {
      const h = e.args[1] ? this.eval(e.args[1], scope, frame) : UNKNOWN;
      this.muxRegister(this.muxDefault(frame.file, at), e, h, scope, frame);
      return [UNKNOWN];
    }
    const args = e.args.map((a) => this.eval(a, scope, frame));
    if (pkg === GIN && (name === "New" || name === "Default")) {
      const r = this.newRouter("gin", frame.file, at);
      const v: V = { k: "router", r, base: "/" };
      for (const a of args) {
        // An option is a function Gin calls with the engine (`OptionFunc`).
        if (a.k === "func") this.invoke(a, [v]);
        else r.unreadSettings = `${this.source(e.args[args.indexOf(a)], frame)}${e.ellipsis && a === args[args.length - 1] ? "..." : ""}`;
      }
      if (r.unreadSettings) this.limit(`${this.at(frame.file, at)} gives gin.${name} options atlas does not read (${r.unreadSettings}); the routes and settings they add are not read`);
      return [v];
    }
    // A middleware made with arguments, known by its name where it is used.
    if (pkg === CHI_MIDDLEWARE && (name === "StripPrefix" || name === "PathRewrite")) return [callee];
    if (pkg === CHI && (name === "NewRouter" || name === "NewMux")) return [{ k: "router", r: this.newRouter("chi", frame.file, at), base: "" }];
    if (pkg === CHI && name === "RegisterMethod") {
      if (args[0]?.k === "str") this.chiMethods.add(args[0].value.toUpperCase());
      return [UNKNOWN];
    }
    if (pkg === HTTP) {
      switch (name) {
        case "NewServeMux": {
          const r = this.newRouter("mux", frame.file, at);
          return [{ k: "router", r, base: "" }];
        }
        case "StripPrefix":
          return [{ k: "handler", files: false, strip: { prefix: args[0]?.k === "str" ? args[0].value : undefined, inner: args[1] ?? UNKNOWN } }];
        case "FileServer":
        case "FileServerFS":
          return [{ k: "handler", files: true }];
        // A handler that passes the request on unchanged serves what it wraps.
        case "TimeoutHandler":
        case "MaxBytesHandler":
        case "AllowQuerySemicolons":
          return [args[0]?.k === "router" ? args[0] : { k: "handler", files: false }];
        case "HandlerFunc":
        case "NotFoundHandler":
        case "RedirectHandler":
          return [{ k: "handler", files: false }];
        default:
          return [UNKNOWN];
      }
    }
    const local = this.byPath.get(pkg);
    if (local?.types.has(name) || (frame.pkg.path === pkg && frame.pkg.types.has(name)) || (!local && frame.pkg.dir === pkg)) return [args[0] ?? UNKNOWN];
    // A router handed to a library function whose result is not used may get routes there that atlas does not read.
    const stdlib = !pkg.split("/")[0]!.includes(".");
    if (statement && !stdlib && ![GIN, CHI, CHI_MIDDLEWARE].includes(pkg)) {
      args.forEach((a, i) => {
        if (a.k === "router") this.limit(`${this.at(frame.file, at)} passes ${this.source(e.args[i], frame)} to ${pkg}.${name}, which atlas does not read; the routes it may register there are not read`);
      });
    }
    this.literals(args, `${pkg}.${name}`);
    return [UNKNOWN];
  }

  /**
   * A call on a value atlas does not trace to a router: where it is declared one (a parameter, a field), or looks like
   * one of the libraries' registrations, a limit names it; function literals passed are read.
   */
  private unknownCall(recv: V & { k: "unknown" }, sel: Expr & { k: "sel" }, e: Expr & { k: "call" }, scope: Scope, frame: Frame): V {
    const args = e.args.map((a) => this.eval(a, scope, frame));
    const name = sel.name;
    const literal = (i: number) => (e.args[i]?.k === "string" ? (e.args[i] as { value?: string }).value : undefined);
    const t = recv.type;
    const gin = new Set([...GIN_VERBS, "Any", "Handle", "Match", "Group", "Static", "StaticFS", "StaticFile", "StaticFileFS"]);
    const chi = new Set([...Object.keys(CHI_VERBS), "Method", "MethodFunc", "Handle", "HandleFunc", "Route", "Mount", "Group"]);
    const imports = new Set(frame.imports.values());
    const pathLike = (s: string | undefined) => s !== undefined && /^(?:[A-Za-z]+[ \t]+)?\//.test(s);
    let registers = false;
    if (t === "gin" || t === "gin-engine") registers = gin.has(name);
    else if (t === "chi") registers = chi.has(name);
    else if (t === "mux") registers = name === "Handle" || name === "HandleFunc";
    else if (!t) {
      registers =
        (imports.has(GIN) && gin.has(name) && /^[A-Z]/.test(name) && name === name.toUpperCase() && pathLike(literal(0))) ||
        (imports.has(GIN) && ["Group", "Static", "StaticFS", "StaticFile", "Any"].includes(name) && pathLike(literal(0))) ||
        (imports.has(CHI) && ["Route", "Mount"].includes(name) && pathLike(literal(0))) ||
        ((imports.has(HTTP) || imports.has(CHI)) && (name === "Handle" || name === "HandleFunc") && pathLike(literal(0)));
    }
    // A function read with no caller, whose call is read on a router where a traced call reaches it, leaves nothing out.
    if (registers && recv.untraced && this.handled.has(`${frame.file}:${e.start}`)) registers = false;
    if (registers) {
      // A router given to a registration atlas does not read (a mount) is served where that puts it.
      args.forEach((a) => this.escape(a, frame, e.start));
      const path = literal(name === "Handle" && (t === "gin" || t === "gin-engine") ? 1 : 0);
      const what = path !== undefined ? `${name} ${JSON.stringify(path)}` : name;
      this.limit(`${this.at(frame.file, this.nameAt(e))} registers ${what} on ${this.source(sel.x, frame)}${recv.why ? ` (${recv.why})` : ""}, which atlas does not trace to a router; it is not read`);
      if (e.args[0]?.k === "string") this.spans.push({ file: frame.file, start: e.args[0].start, end: e.args[0].end });
    }
    // A route group's own routes on a value not traced are named as well.
    if (registers && ((t === "chi" && (name === "Route" || name === "Group")) || (!t && name === "Route"))) {
      const fn = args[name === "Group" ? 0 : 1];
      if (fn?.k === "func") this.invoke(fn, [{ k: "unknown", type: "chi", why: `a router of a group on ${this.source(sel.x, frame)}, not traced` }]);
      return UNKNOWN;
    }
    this.literals(args, this.source(sel, frame));
    if (registers && (name === "Group" || name === "Use" || name === "With")) return { k: "unknown", ...(t ? { type: t } : {}), why: `a group of ${this.source(sel.x, frame)}, not traced` };
    return UNKNOWN;
  }

}

/** The name an embedded field is known by: its type's name (`Engine` of `*gin.Engine`). */
function embeddedName(type: Expr): string | undefined {
  if (type.k === "unary") return embeddedName(type.x);
  if (type.k === "sel") return type.name;
  if (type.k === "ident") return type.name;
  if (type.k === "index") return embeddedName(type.x);
  return undefined;
}

/** Whether two values are the same: one router, group, struct or string. */
function same(a: V | undefined, b: V | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.k === "obj" && b.k === "obj") return a.fields === b.fields;
  if (a.k === "router" && b.k === "router") return a.r === b.r && a.base === b.base;
  if (a.k === "str" && b.k === "str") return a.value === b.value;
  return false;
}

/** A value made unknown, keeping what its static type says it is. */
function forget(v: V): V {
  if (v.k === "unknown") return v;
  if (v.k === "router") return { k: "unknown", type: v.r.lib, why: "a router a branch, a loop or another function may replace" };
  if (v.k === "obj") return { k: "obj", type: v.type, fields: new Map(), vague: `a ${v.type.name} a branch, a loop or another function may replace` };
  return UNKNOWN;
}

/**
 * A value as Go hands it on: a struct value (`byValue`) is copied, with the struct values in its fields; a pointer to a
 * struct, and anything else, is the same value. `force` copies a struct a pointer points to, as a value receiver does.
 */
function copied(v: V, force = false): V {
  if (v.k !== "obj" || (!v.byValue && !force)) return v;
  return { ...v, byValue: true, fields: new Map([...v.fields].map(([k, f]) => [k, copied(f)])) };
}

/**
 * An RE2 regular expression (Go's `regexp`) as a JavaScript one that takes the same text, or undefined where it uses
 * syntax atlas does not carry over: Unicode classes, flags, `\z`, `\A`, `\Q...\E`, POSIX classes. `\s` and `.` are
 * written as RE2 defines them (`[\t\n\f\r ]`, any character but a newline).
 */
export function re2ToJs(src: string): string | undefined {
  let out = "";
  let i = 0;
  const escape = (c: string, inClass: boolean): string | undefined => {
    if ("dDwW".includes(c)) return `\\${c}`;
    if (c === "b" || c === "B") return inClass ? undefined : `\\${c}`;
    if (c === "s") return inClass ? "\\t\\n\\f\\r " : "[\\t\\n\\f\\r ]";
    if (c === "S") return inClass ? undefined : "[^\\t\\n\\f\\r ]";
    if ("ntrfv".includes(c)) return `\\${c}`;
    if (c === "a") return "\\x07";
    if (!/[A-Za-z0-9]/.test(c)) return `\\${c}`;
    return undefined;
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      const n = src[i + 1];
      if (n === undefined) return undefined;
      if (n === "x") {
        const hex = /^[0-9a-fA-F]{2}/.exec(src.slice(i + 2));
        if (!hex) return undefined;
        out += `\\x${hex[0]}`;
        i += 4;
        continue;
      }
      const e = escape(n, false);
      if (e === undefined) return undefined;
      out += e;
      i += 2;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      let body = "[";
      if (src[j] === "^") {
        body += "^";
        j++;
      }
      // A `]` first in a class is a literal one in RE2, an empty class in JavaScript.
      if (src[j] === "]") {
        body += "\\]";
        j++;
      }
      let closed = false;
      while (j < src.length) {
        const d = src[j]!;
        if (d === "]") {
          closed = true;
          break;
        }
        if (d === "[" && src[j + 1] === ":") return undefined;
        if (d === "\\") {
          const n = src[j + 1];
          if (n === undefined) return undefined;
          if (n === "x") {
            const hex = /^[0-9a-fA-F]{2}/.exec(src.slice(j + 2));
            if (!hex) return undefined;
            body += `\\x${hex[0]}`;
            j += 4;
            continue;
          }
          const e = escape(n, true);
          if (e === undefined) return undefined;
          body += e;
          j += 2;
          continue;
        }
        body += d === "[" ? "\\[" : d;
        j++;
      }
      if (!closed) return undefined;
      out += `${body}]`;
      i = j + 1;
      continue;
    }
    if (c === "(" && src[i + 1] === "?") {
      if (src[i + 2] === ":") {
        out += "(?:";
        i += 3;
        continue;
      }
      const named = /^\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(src.slice(i));
      if (!named) return undefined;
      out += `(?<${named[1]}>`;
      i += named[0].length;
      continue;
    }
    // RE2 refuses a repeat count above 1000 (`{1001}`), which JavaScript takes.
    const repeat = c === "{" ? /^\{(\d+)(?:,(\d*))?\}/.exec(src.slice(i)) : null;
    if (repeat && (Number(repeat[1]) > 1000 || Number(repeat[2] || 0) > 1000)) return undefined;
    out += c === "." ? "[^\\n]" : c;
    i++;
  }
  try {
    new RegExp(out);
  } catch {
    return undefined;
  }
  return out;
}

/** Whether a regular expression has a `|` outside its groups and classes, which an anchor before it does not hold. */
function topLevelAlternation(src: string): boolean {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") i++;
    else if (c === "[") {
      i++;
      if (src[i] === "^") i++;
      if (src[i] === "]") i++;
      while (i < src.length && src[i] !== "]") i += src[i] === "\\" ? 2 : 1;
    } else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) return true;
  }
  return false;
}

/**
 * The regexp a chi parameter's value must match, in atlas's form (a JavaScript regexp the whole value must match), or
 * undefined where it is not read. chi puts `^` before the pattern and `$` after it where they are missing, as text, and
 * tests the value with `MatchString` (tree.go `patNextSegment`); the `$` it finds may be an escaped one.
 */
export function chiPattern(rexpat: string): string | undefined {
  let anchored = rexpat;
  if (!anchored.startsWith("^")) anchored = `^${anchored}`;
  if (!anchored.endsWith("$")) anchored = `${anchored}$`;
  const inner = anchored.slice(1, -1);
  const escapedEnd = /(^|[^\\])(\\\\)*\\$/.test(inner);
  if (!escapedEnd && !topLevelAlternation(inner)) return re2ToJs(inner);
  const js = re2ToJs(anchored);
  return js === undefined ? undefined : `[\\s\\S]*?(?:${js})[\\s\\S]*`;
}

/** A route's path as its router holds it, in atlas's form: segments, regexps, and how a trailing `/` is written. */
interface Local {
  segs: string[];
  patterns: Record<string, string>;
  /** The path ends with a `/` (`/x/`), or a wildcard that takes the rest after a `/`. */
  slash: boolean;
  /** The last segment takes the rest of the path. */
  rest: boolean;
  /** For a ServeMux, the method the pattern names; undefined for one that names none. */
  method?: string;
  /** For a ServeMux, the pattern ends with `{$}`. */
  end?: true;
}

const LITERAL = /^[^{}*?]*$/;

/** A Gin path (tree.go `findWildcard`, `insertChild`): `:name` a segment, `*name` the rest after a `/`. */
export function ginPath(path: string): Local | { why: string } {
  if (!path.startsWith("/")) return { why: `${JSON.stringify(path)} does not start with a /, which Gin refuses` };
  // The root `/` has no segment.
  const parts = path === "/" ? [] : path.split("/").slice(1);
  const slash = path.length > 1 && path.endsWith("/");
  if (slash) parts.pop();
  const segs: string[] = [];
  let rest = false;
  for (const [i, s] of parts.entries()) {
    if (s.startsWith(":") || s.startsWith("*")) {
      const name = s.slice(1);
      if (!name || /[:*]/.test(name)) return { why: `${path} has a wildcard Gin refuses (${s})` };
      if (s.startsWith("*")) {
        if (i !== parts.length - 1 || slash) return { why: `${path} has a catch-all before its end, which Gin refuses` };
        rest = true;
        segs.push(`{*${name}}`);
      } else segs.push(`{${name}}`);
      continue;
    }
    if (/[:*]/.test(s)) return { why: `${path} has a wildcard within a segment (${s}), which atlas does not read` };
    if (!LITERAL.test(s)) return { why: `${path} has text atlas's path form would read as a parameter (${s})` };
    segs.push(s);
  }
  return { segs, patterns: {}, slash: slash || rest, rest };
}

/** A chi pattern (tree.go `patNextSegment`): `{name}`, `{name:regexp}` within a segment, and `*` last. */
export function chiPath(pattern: string): Local | { why: string } {
  if (!pattern.startsWith("/")) return { why: `${JSON.stringify(pattern)} does not start with a /, which chi refuses` };
  const segs: string[] = [];
  const patterns: Record<string, string> = {};
  let seg = "";
  let rest = false;
  for (let i = 1; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "/") {
      segs.push(seg);
      seg = "";
      continue;
    }
    if (c === "*") {
      if (i !== pattern.length - 1) return { why: `${pattern} has a * before its end, which chi refuses` };
      if (seg !== "") return { why: `${pattern} has a * after text in its segment, which atlas does not read` };
      rest = true;
      seg = "**";
      continue;
    }
    if (c === "{") {
      let depth = 0;
      let j = i;
      for (; j < pattern.length; j++) {
        if (pattern[j] === "{") depth++;
        else if (pattern[j] === "}" && --depth === 0) break;
      }
      if (j >= pattern.length) return { why: `${pattern} has a { chi finds no closing } for, which chi refuses` };
      const body = pattern.slice(i + 1, j);
      const colon = body.indexOf(":");
      const name = colon < 0 ? body : body.slice(0, colon);
      if (!name || /[{}/*]/.test(name)) return { why: `${pattern} has a parameter whose name atlas does not read ({${body}})` };
      if (Object.hasOwn(patterns, name) || segs.concat(seg).some((s) => s.includes(`{${name}}`))) return { why: `${pattern} names the parameter ${name} twice` };
      if (colon >= 0) {
        const rexpat = body.slice(colon + 1);
        const js = rexpat ? chiPattern(rexpat) : undefined;
        if (js === undefined) return { why: `${pattern} tests ${name} with a regexp atlas does not read (${JSON.stringify(rexpat)})` };
        patterns[name] = js;
      }
      seg += `{${name}}`;
      i = j;
      continue;
    }
    if (/[}?]/.test(c)) return { why: `${pattern} has text atlas's path form would read as a parameter (${c})` };
    seg += c;
  }
  const slash = pattern.length > 1 && pattern.endsWith("/");
  if (!slash) segs.push(seg);
  return { segs: segs.filter((s, i) => s !== "" || i < segs.length - 1), patterns, slash: slash || rest, rest };
}

/** Whether a ServeMux wildcard's name is a Go identifier (pattern.go `isValidWildcardName`). */
const goIdentifier = (s: string): boolean => /^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(s);

/** The characters of an HTTP method token (net/http `validMethod`, RFC 7230 token). */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * A ServeMux pattern as Go 1.22 and later parse it (pattern.go `parsePattern`): a method, a host, and a path of
 * literal segments, `{name}`, a last `{name...}` or `/` taking the rest, and a last `{$}` ending it. `legacy`: as Go 1.21
 * reads it, a path only, a last `/` taking the rest.
 */
export function muxPattern(pattern: string, legacy: boolean): Local | { why: string } {
  let method: string | undefined;
  let rest = pattern;
  const space = pattern.search(/[ \t]/);
  if (legacy) {
    if (space >= 0 || pattern.includes("{")) return { why: `${JSON.stringify(pattern)} is read by Go before 1.22 (or with GODEBUG httpmuxgo121=1) as a path with a host or literal braces, which atlas does not read` };
  } else if (space >= 0) {
    method = pattern.slice(0, space);
    rest = pattern.slice(space + 1).replace(/^[ \t]+/, "");
    if (!TOKEN.test(method)) return { why: `${JSON.stringify(pattern)} has a method Go refuses` };
  }
  const slashAt = rest.indexOf("/");
  if (slashAt < 0) return { why: `${JSON.stringify(pattern)} has no /, which Go refuses` };
  if (slashAt > 0) return { why: `${JSON.stringify(pattern)} matches requests by host (${rest.slice(0, slashAt)}), which atlas does not read` };
  if (goClean(rest) !== rest && !(rest.endsWith("/") && goClean(rest) + "/" === rest)) return { why: `${JSON.stringify(pattern)} has a path Go cleans away before it matches (${rest}), so it matches no request` };
  if (rest.includes("%")) return { why: `${JSON.stringify(pattern)} has an escaped character, which atlas does not read` };
  const segs: string[] = [];
  const names = new Set<string>();
  let slash = false;
  let tail = false;
  let dollar = false;
  let remaining = rest;
  while (remaining.length) {
    remaining = remaining.slice(1);
    if (!remaining.length) {
      segs.push("**");
      slash = true;
      tail = true;
      break;
    }
    const end = remaining.indexOf("/");
    const seg = end < 0 ? remaining : remaining.slice(0, end);
    remaining = end < 0 ? "" : remaining.slice(end);
    if (legacy || !seg.includes("{")) {
      if (!LITERAL.test(seg)) return { why: `${JSON.stringify(pattern)} has text atlas's path form would read as a parameter (${seg})` };
      segs.push(seg);
      continue;
    }
    if (!seg.startsWith("{") || !seg.endsWith("}")) return { why: `${JSON.stringify(pattern)} has a wildcard that is not a segment whole, which Go refuses` };
    const name = seg.slice(1, -1);
    if (name === "$") {
      if (remaining.length) return { why: `${JSON.stringify(pattern)} has {$} before its end, which Go refuses` };
      slash = segs.length > 0;
      dollar = true;
      break;
    }
    const multi = name.endsWith("...");
    const bare = multi ? name.slice(0, -3) : name;
    if (multi && remaining.length) return { why: `${JSON.stringify(pattern)} has a {...} wildcard before its end, which Go refuses` };
    if (!goIdentifier(bare) || names.has(bare)) return { why: `${JSON.stringify(pattern)} has a wildcard name Go refuses ({${name}})` };
    names.add(bare);
    segs.push(multi ? `{*${bare}}` : `{${bare}}`);
    if (multi) {
      slash = true;
      tail = true;
    }
  }
  if (segs.length === 1 && segs[0] === "**") slash = false;
  if (tail && segs.length === 1) slash = false;
  return { segs, patterns: {}, slash, rest: tail, ...(method !== undefined ? { method } : {}), ...(dollar ? { end: true as const } : {}) };
}

/** A ServeMux pattern's segments as Go holds them (pattern.go `segment`): a literal, a wildcard, or a remainder. */
function goSegments(l: Local): Array<{ s: string; wild: boolean; multi: boolean }> {
  const out = l.segs.map((seg) => (isRest(seg) ? { s: "", wild: true, multi: true } : seg.startsWith("{") ? { s: seg, wild: true, multi: false } : { s: seg, wild: false, multi: false }));
  if (l.end) out.push({ s: "/", wild: false, multi: false });
  return out;
}

const isRest = (seg: string) => seg === "**" || seg.startsWith("{*");

type Relation = "equivalent" | "moreGeneral" | "moreSpecific" | "disjoint" | "overlaps";
const inverse = (r: Relation): Relation => (r === "moreGeneral" ? "moreSpecific" : r === "moreSpecific" ? "moreGeneral" : r);

/** pattern.go `combineRelationships`. */
function combine(r1: Relation, r2: Relation): Relation {
  if (r1 === "equivalent") return r2;
  if (r1 === "disjoint") return "disjoint";
  if (r1 === "overlaps") return r2 === "disjoint" ? "disjoint" : "overlaps";
  if (r2 === "equivalent") return r1;
  if (r2 === inverse(r1)) return "overlaps";
  return r2;
}

/**
 * Whether two patterns conflict as ServeMux registers them (pattern.go `conflictsWith`, `comparePathsAndMethods`):
 * they match some request alike and neither matches only requests the other does. Go 1.21's mux refuses only the
 * same pattern twice.
 */
export function muxConflict(a: Local, b: Local, legacy: boolean): boolean {
  const s1 = goSegments(a);
  const s2 = goSegments(b);
  const same = a.method === b.method && JSON.stringify(s1) === JSON.stringify(s2);
  if (legacy) return same;
  const m1 = a.method ?? "";
  const m2 = b.method ?? "";
  let mrel: Relation;
  if (m1 === m2) mrel = "equivalent";
  else if (m1 === "") mrel = "moreGeneral";
  else if (m2 === "") mrel = "moreSpecific";
  else if (m1 === "GET" && m2 === "HEAD") mrel = "moreGeneral";
  else if (m1 === "HEAD" && m2 === "GET") mrel = "moreSpecific";
  else return false;
  const last1 = s1[s1.length - 1];
  const last2 = s2[s2.length - 1];
  const paths = (): Relation => {
    if (s1.length !== s2.length && !last1?.multi && !last2?.multi) return "disjoint";
    let rel: Relation = "equivalent";
    let i = 0;
    for (; i < s1.length && i < s2.length; i++) {
      const x = s1[i]!;
      const y = s2[i]!;
      let r: Relation;
      if (x.multi && y.multi) r = "equivalent";
      else if (x.multi) r = "moreGeneral";
      else if (y.multi) r = "moreSpecific";
      else if (x.wild && y.wild) r = "equivalent";
      else if (x.wild) r = y.s === "/" ? "disjoint" : "moreGeneral";
      else if (y.wild) r = x.s === "/" ? "disjoint" : "moreSpecific";
      else r = x.s === y.s ? "equivalent" : "disjoint";
      rel = combine(rel, r);
      if (rel === "disjoint") return rel;
    }
    if (i === s1.length && i === s2.length) return rel;
    if (s1.length < s2.length && last1?.multi) return combine(rel, "moreGeneral");
    if (s2.length < s1.length && last2?.multi) return combine(rel, "moreSpecific");
    return "disjoint";
  };
  const rel = combine(mrel, paths());
  return rel === "equivalent" || rel === "overlaps";
}

/** Where a router's routes are served: the path before them, as the mounts on the way there join it. */
interface Place {
  segs: string[];
  patterns: Record<string, string>;
  /** chi: the segments before each router mounted on the way, from the outermost. */
  mounted: number[];
  how: "root" | "chi" | "strip" | "declared";
  /** chi: the mount's pattern has no `/` at its end, so chi also serves its path and the path with a `/` (`Mount`). */
  stubs: boolean;
  /** chi middlewares on the way that rewrite a request's trailing `/`, where they are used. */
  rewrites: string[];
  /** chi's `middleware.GetHead` is used on the way. */
  headByGet: boolean;
  /** The segments before each ServeMux subtree on the way (`Dispatch.under`). */
  under: number[];
}

/** The most paths one router is read under, a guard against runaway nesting. */
const MAX_PLACES = 64;

function mergePatterns(a: Record<string, string>, b: Record<string, string>): Record<string, string> | undefined {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (Object.hasOwn(out, k) && out[k] !== v) return undefined;
    out[k] = v;
  }
  return out;
}

class Assembly {
  readonly routes: GoRoute[] = [];
  /** The HEAD a GET route also serves, after every route registered, so that a HEAD route registered for the path is the one kept. */
  readonly heads: GoRoute[] = [];
  private readonly places = new Map<Router, Place[]>();

  constructor(
    private readonly interp: Interp,
    private readonly modules: (file: string) => Module | undefined,
    /** The modules (by go.mod) whose main packages say `//go:debug httpmuxgo121=1`. */
    private readonly legacyDirective: Set<string>,
  ) {}

  private limit(text: string): void {
    this.interp.limit(text);
  }

  /** The places a router is served at; none where every mount of it is not read. */
  placesOf(r: Router, seen: Set<Router> = new Set()): Place[] {
    if (this.places.has(r)) return this.places.get(r)!;
    if (seen.has(r)) {
      this.limit(`${r.file}:${r.line} makes a router that is mounted into itself; its routes are not read there`);
      return [];
    }
    seen.add(r);
    const rewrites = r.rewrites ?? [];
    let out: Place[] = [];
    const traced = r.mounts.some((m) => m.prefix !== undefined);
    if (r.escaped) {
      this.limit(`${r.file}:${r.line} makes a router that ${r.escaped} passes on where atlas does not follow it; ${traced || r.declared !== undefined ? "a mount of it from there" : "where it is served"} is not read${traced || r.declared !== undefined ? "" : ", so its routes are not read"}`);
      if (!traced && r.declared === undefined) {
        seen.delete(r);
        this.places.set(r, []);
        return [];
      }
    }
    if (r.declared !== undefined && !traced) {
      out = [{ segs: r.declared.split("/").filter(Boolean), patterns: {}, mounted: [], how: "declared", stubs: true, rewrites, headByGet: !!r.headByGet, under: [] }];
    } else if (!r.mounts.length) {
      out = [{ segs: [], patterns: {}, mounted: [], how: "root", stubs: false, rewrites, headByGet: !!r.headByGet, under: [] }];
    } else {
      for (const m of r.mounts) {
        if (m.prefix === undefined) continue;
        const parents = this.placesOf(m.parent, seen);
        for (const p of parents) {
          const place = this.join(p, m, r, rewrites);
          if (place) out.push(place);
        }
      }
    }
    if (out.length > MAX_PLACES) {
      this.limit(`${r.file}:${r.line} makes a router mounted at more than ${MAX_PLACES} paths; its routes are not read`);
      out = [];
    }
    seen.delete(r);
    this.places.set(r, out);
    return out;
  }

  private join(p: Place, m: Mount, r: Router, rewrites: string[]): Place | undefined {
    const where = `${m.file}:${m.line}`;
    const headByGet = p.headByGet || !!r.headByGet;
    if (m.how === "root") return { ...p, rewrites: [...p.rewrites, ...rewrites], headByGet };
    if (m.how === "chi") {
      const local = chiPath(m.prefix!);
      if ("why" in local) return void this.limit(`${where} mounts a router at ${local.why}; its routes are not read`);
      if (local.rest) return void this.limit(`${where} mounts a router at ${m.prefix}, whose * chi refuses in a mount; its routes are not read`);
      const patterns = mergePatterns(p.patterns, local.patterns);
      if (!patterns) return void this.limit(`${where} mounts a router at ${m.prefix}, which names a parameter of its mount again with another regexp; its routes are not read`);
      const segs = [...p.segs, ...local.segs];
      return { segs, patterns, mounted: [...p.mounted, segs.length], how: "chi", stubs: !m.prefix!.endsWith("/"), rewrites: [...p.rewrites, ...rewrites], headByGet, under: p.under };
    }
    // http.StripPrefix(prefix, router) under a ServeMux subtree `prefix/`: the router sees the path after the prefix.
    const go = this.goOf(m.file);
    if ("why" in go) return void this.limit(`${where} ${go.why}; the routes of the router it serves are not read`);
    const outer = muxPattern(m.pattern ?? "", go.legacy);
    const lits = "why" in outer ? undefined : outer.segs.slice(0, -1);
    if ("why" in outer || outer.method !== undefined || !outer.rest || outer.segs[outer.segs.length - 1] !== "**" || !lits!.every((s) => LITERAL.test(s) && !s.includes("{")) || `/${lits!.join("/")}` !== m.prefix || !lits!.length) {
      return void this.limit(`${where} serves a router under ${JSON.stringify(m.pattern)} with http.StripPrefix(${JSON.stringify(m.prefix)}); atlas reads such a mount only where the pattern is a subtree with no method and StripPrefix removes its path without the last /, so its routes are not read`);
    }
    const segs = [...p.segs, ...lits!];
    return { segs, patterns: p.patterns, mounted: [], how: "strip", stubs: false, rewrites, headByGet: !!r.headByGet, under: [...p.under, segs.length] };
  }

  /** The Go a file's ServeMux patterns are read with: 1.22's, or 1.21's where go.mod says an earlier one or GODEBUG asks. */
  private goOf(file: string): { legacy: boolean } | { why: string } {
    const m = this.modules(file);
    if (!m) return { why: `has no go.mod above it to tell which Go reads its ServeMux patterns` };
    // A go.mod without a `go` line is read as Go 1.16 (go.dev/ref/mod#go-mod-file-go).
    return { legacy: m.legacyMux || this.legacyDirective.has(m.file) || !m.go || !atLeast122(m.go) };
  }

  add(r: Router): void {
    const places = this.placesOf(r);
    if (!places.length) return;
    const kept: Array<{ reg: Reg; local: Local; legacy: boolean }> = [];
    for (const reg of r.regs) {
      const where = `${reg.file}:${reg.line}`;
      let local: Local | { why: string };
      if (r.lib === "mux") {
        const go = this.goOf(reg.file);
        if ("why" in go) {
          this.limit(`${where} ${go.why}; the route is not read`);
          continue;
        }
        local = muxPattern(reg.path, go.legacy);
        if (!("why" in local)) {
          // ServeMux refuses a pattern that conflicts with one registered before it: Register panics.
          const parsed = local;
          const clash = kept.find((k) => muxConflict(k.local, parsed, go.legacy));
          if (clash) {
            this.limit(`${where} registers ${JSON.stringify(reg.path)}, which conflicts with ${JSON.stringify(clash.reg.path)} (${clash.reg.file}:${clash.reg.line}): neither is more specific, and ServeMux panics as it is registered; the route is not read`);
            continue;
          }
          kept.push({ reg, local: parsed, legacy: go.legacy });
        }
      } else if (r.lib === "gin") local = ginPath(reg.path);
      else local = chiPath(reg.path);
      if ("why" in local) {
        this.limit(`${where} registers ${local.why}; the route is not read`);
        continue;
      }
      if (reg.mountAll) {
        if (local.rest) {
          this.limit(`${where} mounts a handler at ${reg.path}, whose * chi refuses in a mount; it is not read`);
          continue;
        }
        local = { ...local, segs: [...local.segs, "**"], rest: true, slash: reg.path.endsWith("/") };
      }
      let methods: string[];
      if (r.lib === "mux") methods = [local.method ?? "*"];
      else methods = reg.methods === "*" ? ["*"] : reg.methods;
      if (r.lib === "chi") {
        methods = methods.filter((m) => {
          if (m === "*" || CHI_METHODS.has(m) || this.interp.chiMethods.has(m)) return true;
          this.limit(`${where} registers a route with the method ${m}, which chi refuses unless chi.RegisterMethod adds it, and no code of the route files does; it is not read`);
          return false;
        });
      }
      for (const place of places) {
        const patterns = mergePatterns(place.patterns, local.patterns);
        if (!patterns) {
          this.limit(`${where} registers ${reg.path}, which names a parameter of its mount again with another regexp; it is not read`);
          continue;
        }
        const { path, trailing } = this.combine(place, local, !!reg.mountAll, reg.path.endsWith("/"));
        const dispatch: Dispatch = this.dispatchOf(r, place, trailing);
        const add = (method: string, extra: Partial<GoRoute> = {}) =>
          (extra.implicit ? this.heads : this.routes).push({
            method,
            path,
            ...(Object.keys(patterns).length ? { patterns } : {}),
            file: reg.file,
            line: reg.line,
            ...(reg.implicit ? { implicit: true } : {}),
            ...(reg.convention ? { convention: reg.convention } : {}),
            dispatch,
            ...extra,
          });
        for (const m of methods) {
          add(m);
          // A ServeMux pattern with GET also serves HEAD (routing_tree.go `matchMethodAndPath`), as a chi GET route does
          // under middleware.GetHead.
          if ((r.lib === "mux" || (r.lib === "chi" && place.headByGet)) && m === "GET") add("HEAD", { implicit: true });
        }
      }
    }
  }

  /** A route's path where a place serves it, and how a trailing `/` is written there. */
  private combine(place: Place, local: Local, mountAll: boolean, mountSlash: boolean): { path: string; trailing: Dispatch["trailing"] } {
    const segs = [...place.segs, ...local.segs];
    let trailing: Dispatch["trailing"];
    const before = segs.length - (local.rest ? 1 : 0);
    if (before === 0) trailing = undefined;
    else if (local.rest) {
      // A handler chi mounts takes the mount's path with and without a `/` unless the pattern ends with one; a wildcard
      // at a mounted router's root takes the empty rest after the mount's `/`, which chi also serves without it.
      const atRoot = local.segs.length === 1;
      if (mountAll) trailing = mountSlash ? "slash" : undefined;
      else trailing = atRoot && ((place.how === "chi" && place.stubs) || place.how === "declared") ? undefined : "slash";
    } else if (!local.segs.length) trailing = place.how === "chi" ? (place.stubs ? "both" : "slash") : place.how === "declared" ? "both" : "slash";
    else trailing = local.slash ? "slash" : undefined;
    return { path: `/${segs.join("/")}`, trailing };
  }

  private dispatchOf(r: Router, place: Place, trailing: Dispatch["trailing"]): Dispatch {
    const t = trailing ? { trailing } : {};
    const under = place.under.length ? { under: place.under } : {};
    if (r.lib === "gin") {
      const slashes = r.unreadSettings || r.tsr === null ? {} : { slashes: r.tsr ? ("tsr" as const) : ("strict" as const) };
      return { picks: "httprouter", ...slashes, ...t, ...under };
    }
    if (r.lib === "chi") {
      const slashes = place.rewrites.length ? {} : { slashes: "strict" as const };
      return { picks: "chi", ...slashes, ...t, ...(place.mounted.length ? { mounted: place.mounted } : {}), ...under };
    }
    return { picks: "servemux", slashes: "subtree", ...t, ...under };
  }
}

/**
 * The routes the Go files register with Gin, chi and net/http, read from the functions no code of theirs calls; each
 * route under every path its router is mounted at. `read` reads the go.mod above a file; `declared` gives the path
 * the routers of a file are served under where their mounts are not read (`mounts`).
 */
export function goRoutes(
  texts: Map<string, string>,
  component: string,
  read: (path: string) => string | undefined,
  declared: Record<string, string> = {},
): { routes: GoRoute[]; limits: string[]; spans: Array<{ file: string; start: number; end: number }> } {
  const pkgs = loadPackages(texts, read);
  const interp = new Interp(pkgs, component, declared);
  interp.run();
  const modules = new Map(pkgs.flatMap((p) => p.files.map((f) => [f.file, p.module] as const)));
  // `//go:debug httpmuxgo121=1` in a main package's file (go.dev/doc/godebug).
  // `//go:debug httpmuxgo121=1` in a file of a main package sets it for that program (go.dev/doc/godebug).
  const directive = new Set(
    pkgs.flatMap((p) => (p.name === "main" && p.module && p.files.some((f) => /^\/\/go:debug\s+(?:[^\n]*[\s,])?httpmuxgo121=1\b/m.test(f.text)) ? [p.module.file] : [])),
  );
  const assembly = new Assembly(interp, (file) => modules.get(file) ?? undefined, directive);
  for (const r of interp.routers) assembly.add(r);
  for (const r of interp.routers) {
    const rewrites = r.rewrites ?? [];
    if (rewrites.length) interp.limit(`${r.file}:${r.line} makes a chi router that uses middleware.${rewrites.join(" and middleware.")}, which rewrites a request's trailing /; how its routes and those mounted on it take a request with or without one is not read`);
    if (r.pathRewrites?.length) interp.limit(`${r.file}:${r.line} makes a chi router that uses ${r.pathRewrites.join(" and ")}, which routes a request by another path than it names; its routes are read at the paths they are written at, and a request rewritten to one of them is not`);
  }
  return { routes: [...assembly.routes, ...assembly.heads], limits: [...interp.limits], spans: interp.spans };
}
