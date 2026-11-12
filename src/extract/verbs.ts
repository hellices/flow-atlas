import type { Argument, Frame, TextCalls } from "./calls.js";

/**
 * The method a request read as text is sent with, where a client library sets it through its own API: a call named for
 * it, an annotation or attribute, an argument or option that states it, a builder's call before or after the URL, an
 * assignment to the request. A method is read only where the code states it for certain, by a literal method name or
 * by a library's own constant for one; one held in a value, or set where atlas does not follow, is `*`.
 *
 * Each rule follows the library's documentation and source:
 * - every language: a method call named for a method (`client.get(url)`, `R().Post(url)`, `http.Head(url)`), its
 *   first argument the URL, the URL also built inside it (`http.get(Uri.parse(...))`, `http.Get(fmt.Sprintf(...))`).
 * - Retrofit: the method annotations (`@GET("users")`) and `@HTTP(method = "DELETE", path = ...)`.
 * - Refit: the verb attributes (`[Get("/users")]`).
 * - Spring: RestTemplate's methods (`getForObject`, `postForEntity`, ...), its `exchange` and `execute` with an
 *   `HttpMethod` constant after the URL; RestClient's and WebClient's `get()` or `method(HttpMethod.X)` before
 *   `.uri(...)`.
 * - OkHttp: the method calls of a `Request.Builder()` chain around its `.url(...)` up to `.build()`, GET without one.
 * - Ktor: `request(url) { method = HttpMethod.X }`, GET without a method; `submitForm`, POST unless it encodes its
 *   form in the query.
 * - Go: net/http's `NewRequest(method, url, ...)`, `NewRequestWithContext(ctx, method, url, ...)` and `PostForm`;
 *   resty's `Execute(method, url)`; the method a literal or the package's `MethodX` constant.
 * - Python: `request(method, url)` and `build_request(method, url)` on any receiver (Requests, HTTPX, urllib3,
 *   aiohttp and http.client take the method first), and the `Request(method, url)` of Requests and HTTPX.
 * - Dart: package:http's `Request(method, url)` (and its multipart and streamed requests), `read` and `readBytes`;
 *   dio's `query` and the method in `request`'s `Options(method: ...)`.
 * - Swift: Alamofire's `AF.request(url, method: .x)`, GET without a method; a `URLRequest(url:)` with the
 *   `httpMethod` (or Alamofire's `method`) it is given, GET without one; URLSession's `data(from:)`, `bytes(from:)`
 *   and `download(from:)`, which load a URL with GET.
 * - .NET: HttpClient's methods (`GetAsync`, `PostAsJsonAsync`, `DeleteAsync`, `GetFromJsonAsync`, ...) and
 *   `new HttpRequestMessage(HttpMethod.X, uri)`.
 */
export class TextMethods {
  private readonly lang: "jvm" | "kotlin" | "go" | "python" | "dart" | "swift" | "csharp" | undefined;
  private masked?: string;
  private closes?: Map<number, Frame>;
  private dots?: Map<number, Frame>;
  private goNames?: Map<string, string>;
  private dartPrefixes?: Map<string, string[]>;
  private pythonNames?: { modules: Map<string, string>; names: Map<string, string> };

  constructor(
    file: string,
    private readonly text: string,
    private readonly scan: TextCalls,
    private readonly receivers: string[] = [],
  ) {
    this.lang = /\.java$/.test(file)
      ? "jvm"
      : /\.kts?$/.test(file)
        ? "kotlin"
        : /\.go$/.test(file)
          ? "go"
          : /\.pyi?$/.test(file)
            ? "python"
            : /\.dart$/.test(file)
              ? "dart"
              : /\.swift$/.test(file)
                ? "swift"
                : /\.cs$/.test(file)
                  ? "csharp"
                  : undefined;
  }

  /**
   * The method of the request whose URL holds the string argument `a`: the call it is given to decides, or, where that
   * call only builds the URL (`Uri.parse(...)`, `fmt.Sprintf(...)`, a `+` in parentheses), the call that call's result
   * is given to. Undefined where no call around it states a method.
   */
  of(a: Argument): string | undefined {
    let frame = this.scan.frames.get(a.call);
    let slot = a.index;
    for (let depth = 0; frame && frame.open === "(" && depth < 8; depth++) {
      if (frame.name !== undefined) {
        const method = this.callMethod(frame, slot);
        if (method === STOP) return undefined;
        if (method !== undefined) return method;
      }
      if (frame.outer === undefined || frame.slot === undefined) return undefined;
      slot = frame.slot;
      frame = this.scan.frames.get(frame.outer);
    }
    return undefined;
  }

  /** The method a call states for the URL in its argument `slot`; STOP where the argument is no URL of a request it names. */
  private callMethod(f: Frame, slot: number): string | typeof STOP | undefined {
    const name = f.name!;
    const label = this.label(f, slot);
    const first = slot === 0 && (label === undefined || URL_LABELS.has(label));
    if (f.annotation) {
      if ((this.lang === "jvm" || this.lang === "kotlin") && RETROFIT_VERBS.has(name)) return slot === 0 && (label === undefined || label === "value") ? name : STOP;
      if ((this.lang === "jvm" || this.lang === "kotlin") && name === "HTTP") return label === "path" ? (literalMethod(this.value(f, "method"), true) ?? "*") : STOP;
      if (this.lang === "csharp" && REFIT_VERBS.has(name)) return first ? name.toUpperCase() : STOP;
      return STOP;
    }
    const own = this.ownMethod(f, slot, label, first);
    if (own !== undefined) return own;
    // A call on a client the call source names, given a method just before the URL (`c.newRequest(ctx, http.MethodGet,
    // path, nil)`, `api.send("POST", url)`), sends it with that method.
    if (f.method && f.receiver !== undefined && this.receivers.includes(f.receiver) && slot >= 1) {
      const method = this.stated(this.part(f, slot - 1));
      if (method !== undefined) return method;
    }
    if (f.method && VERBS.has(name.toLowerCase())) return first ? name.toUpperCase() : STOP;
    return undefined;
  }

  private ownMethod(f: Frame, slot: number, label: string | undefined, first: boolean): string | typeof STOP | undefined {
    const name = f.name!;
    switch (this.lang) {
      case "jvm":
      case "kotlin": {
        if (!f.method) return undefined;
        const template = REST_TEMPLATE.get(name);
        if (template) return first ? template : STOP;
        if ((name === "exchange" || name === "execute") && first) {
          const method = /^HttpMethod\s*\.\s*([A-Z]+)$/.exec(this.part(f, 1) ?? "")?.[1];
          return method && SPRING_METHODS.has(method) ? method : undefined;
        }
        if (name === "uri" && first) return this.springMethod(f);
        if (name === "url" && first) return this.okHttpMethod(f);
        if (this.lang === "kotlin" && name === "request" && (slot === 0 ? label === undefined || label === "urlString" : label === "urlString") && this.imports(KTOR_REQUEST)) return this.ktorMethod(f, "GET", 1);
        if (this.lang === "kotlin" && name === "submitForm" && (slot === 0 ? label === undefined || label === "url" : label === "url") && this.imports(KTOR_FORMS)) {
          const encoded = this.value(f, "encodeInQuery") ?? (this.label(f, 2) === undefined ? this.part(f, 2) : undefined);
          const method = encoded === undefined || encoded === "false" ? "POST" : encoded === "true" ? "GET" : "*";
          return method === "*" ? "*" : this.ktorMethod(f, method, 3);
        }
        return undefined;
      }
      case "go": {
        const http = this.goName("net/http");
        if (f.method && name === "PostForm" && http !== undefined && (f.receiver === http || this.goClient(f, http))) return first ? "POST" : STOP;
        if (f.method && f.receiver !== undefined && f.receiver === http && (name === "NewRequest" || name === "NewRequestWithContext")) {
          const at = name === "NewRequest" ? 0 : 1;
          return slot === at + 1 ? this.goMethod(this.part(f, at)) : STOP;
        }
        if (f.method && name === "Execute") return slot === 1 ? this.goMethod(this.part(f, 0)) : undefined;
        return undefined;
      }
      case "python": {
        const known = f.method ? name === "request" || name === "build_request" || (name === "Request" && f.receiver !== undefined && this.pythonModule(f.receiver)) : this.pythonImported(name);
        if (!known) return undefined;
        const url = label === "url" || (label === undefined && slot === 1);
        if (!url) return STOP;
        const method = this.value(f, "method") ?? (this.label(f, 0) === undefined ? this.part(f, 0) : undefined);
        return literalMethod(method, false) ?? "*";
      }
      case "dart": {
        const http = this.dartPrefix("package:http/http.dart");
        if (f.method && name === "query") return first ? "QUERY" : STOP;
        if (f.method && (name === "read" || name === "readBytes") && f.receiver !== undefined && http.includes(f.receiver)) return first ? "GET" : STOP;
        if (DART_REQUESTS.has(name) && (f.method ? f.receiver !== undefined && http.includes(f.receiver) : http.includes(""))) {
          return slot === 1 && label === undefined ? (literalMethod(this.label(f, 0) === undefined ? this.part(f, 0) : undefined, true) ?? "*") : STOP;
        }
        if (f.method && name === "request" && first) return this.dioMethod(f);
        return undefined;
      }
      case "swift": {
        if (f.method && name === "request" && first) {
          const method = this.value(f, "method");
          if (method !== undefined) return swiftMethod(method) ?? "*";
          return f.receiver === "AF" ? "GET" : undefined;
        }
        if (!f.method && name === "URLRequest" && label === "url") return this.urlRequestMethod(f);
        // URLSession's methods that take a URL, not a URLRequest, send GET (Foundation, URLSession).
        if (f.method && URL_SESSION_GETS.has(name) && label === "from") return "GET";
        return undefined;
      }
      case "csharp": {
        const client = DOTNET_METHODS.get(name);
        if (f.method && client) return slot === 0 && (label === undefined || label === "requestUri") ? client : STOP;
        if (!f.method && name === "HttpRequestMessage") {
          if (!(label === "requestUri" || (label === undefined && slot === 1))) return STOP;
          const method = this.value(f, "method") ?? (this.label(f, 0) === undefined ? this.part(f, 0) : undefined);
          return dotnetMethod(method) ?? "*";
        }
        return undefined;
      }
      default:
        return undefined;
    }
  }

  /** Whether the argument just before `a` in its call states a method, as a literal or a library's constant for one. */
  statedBefore(a: Pick<Argument, "call" | "index">): boolean {
    const f = this.scan.frames.get(a.call);
    return !!f && a.index >= 1 && this.stated(this.part(f, a.index - 1)) !== undefined;
  }

  /**
   * Whether `a` is the URL of an OkHttp `Request.Builder()` chain whose later `.url(...)` replaces it before
   * `.build()`: the request is not sent to it.
   */
  replaced(a: Pick<Argument, "call" | "index">): boolean {
    const url = this.scan.frames.get(a.call);
    if (!url || url.name !== "url" || !url.method || a.index !== 0 || (this.lang !== "jvm" && this.lang !== "kotlin")) return false;
    const chain = this.okHttpChain(url);
    return !!chain && chain.chain.some((c) => c !== url && c.name === "url" && c.at > url.at);
  }

  /** A method a call's argument states: a literal, as written, or the constant of a library of the file's language. */
  private stated(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;
    const literal = literalMethod(text, true) ?? literalMethod(text, false);
    if (literal !== undefined) return literal;
    if (this.lang === "go") {
      const method = this.goMethod(text);
      return method === "*" ? undefined : method;
    }
    if (this.lang === "jvm" || this.lang === "kotlin") {
      const method = /^HttpMethod\s*\.\s*([A-Z]+)$/.exec(text)?.[1];
      return method && SPRING_METHODS.has(method) ? method : undefined;
    }
    if (this.lang === "csharp") return dotnetMethod(text);
    if (this.lang === "swift") return /^HTTPMethod\s*\.\s*[a-z]+$/.test(text.trim()) ? swiftMethod(text) : undefined;
    return undefined;
  }

  /** RestClient's or WebClient's method: the call `.uri(...)` is made on, `get()` or `method(HttpMethod.X)`. */
  private springMethod(uri: Frame): string | undefined {
    const before = this.previous(uri);
    if (!before?.name || !before.method) return undefined;
    if (VERBS.has(before.name) && this.empty(before)) return before.name.toUpperCase();
    if (before.name !== "method") return undefined;
    const method = /^HttpMethod\s*\.\s*([A-Z]+)$/.exec(this.part(before, 0) ?? "")?.[1];
    return method && SPRING_METHODS.has(method) ? method : "*";
  }

  /**
   * OkHttp's method for a `Request.Builder()` chain that sets its URL with `.url(...)`: the last of its method calls
   * (`get()`, `post(body)`, `method("PATCH", body)`, ...) up to `.build()`, GET where it makes none, as the builder's
   * default is. A chain with another call, or that ends before `.build()`, may get its method elsewhere: `*`.
   */
  private okHttpMethod(url: Frame): string | undefined {
    const found = this.okHttpChain(url);
    if (!found) return undefined;
    const { chain, last } = found;
    if (last.name !== "build") return "*";
    // A later `url(...)` replaces this one: the request is not sent to it.
    if (chain.some((c) => c !== url && c.name === "url" && c.at > url.at)) return "*";
    let method = "GET";
    for (const c of chain.slice(1, -1)) {
      const name = c.name ?? "";
      if (OKHTTP_SETTERS.has(name)) continue;
      const verb = OKHTTP_METHODS.get(name);
      if (verb) method = verb;
      else if (name === "method") method = literalMethod(this.part(c, 0), true) ?? "*";
      else return "*";
    }
    return method;
  }

  /** The `Request.Builder()` chain a `.url(...)` call is in, from the builder through `.build()` or as far as it goes. */
  private okHttpChain(url: Frame): { chain: Frame[]; last: Frame } | undefined {
    let start = url;
    const chain: Frame[] = [url];
    for (let p = this.previous(url); p; p = this.previous(p)) {
      chain.unshift(p);
      start = p;
    }
    if (start.name !== "Builder" || start.receiver !== "Request" || !this.empty(start)) return undefined;
    let last = url;
    for (let n = this.following(url); n && last.name !== "build"; n = this.following(n)) {
      chain.push(n);
      last = n;
    }
    return { chain, last };
  }

  /**
   * Ktor's method for a request whose builder block may set it: the `method = HttpMethod.X` the block states at its top,
   * else `fallback` where the block names no `method` at all; `*` otherwise. `position` is the block parameter's.
   */
  private ktorMethod(f: Frame, fallback: string, position: number): string {
    // The block is the trailing lambda, or the argument `block` (by name or in its place): an inline lambda is read,
    // a builder held in a value may set any method.
    const index = f.parts.findIndex((_, i) => this.label(f, i) === "block");
    const at = index >= 0 ? index : this.label(f, position) === undefined && this.part(f, position) !== undefined ? position : -1;
    let block: Frame | undefined;
    if (at >= 0) {
      const p = f.parts[at]!;
      const value = /^\s*(?:block\s*=\s*)?\{/.exec(this.text.slice(p.start, p.end));
      block = value ? this.scan.frames.get(p.start + value[0].length - 1) : undefined;
      if (!block || block.close === undefined || this.text.slice(block.close + 1, p.end).trim()) return "*";
    } else {
      const after = /^\s*\{/.exec(this.text.slice((f.close ?? this.text.length) + 1));
      block = after ? this.scan.frames.get((f.close ?? 0) + after[0].length) : undefined;
    }
    if (!block) return fallback;
    const code = this.code().slice(block.at + 1, block.close ?? this.text.length);
    const sets = [...code.matchAll(/(?<![\w.$])method\s*=(?!=)\s*([^\n;]*)/g)];
    if (sets.length === 0) return /(?<![\w$])method(?![\w$])/.test(code) ? "*" : fallback;
    if (sets.length > 1 || this.innermost(block.at + 1 + sets[0]!.index) !== block) return "*";
    const constant = /^HttpMethod\s*\.\s*([A-Z][a-z]+)\s*$/.exec(sets[0]![1]!)?.[1]?.toUpperCase();
    return constant && KNOWN.has(constant) ? constant : "*";
  }

  /** dio's method for `request(path, options: Options(method: ...))`: the one `Options` states, `*` otherwise. */
  private dioMethod(f: Frame): string {
    const index = f.parts.findIndex((_, i) => this.label(f, i) === "options");
    const options = index >= 0 ? this.value(f, "options") : undefined;
    const m = options && /^(?:([A-Za-z_]\w*)\s*\.\s*)?Options\s*\(/.exec(options);
    if (!m || !this.dartPrefix("package:dio/dio.dart").includes(m[1] ?? "")) return "*";
    // The options are that `Options(...)` whole, not a value built from it.
    const call = [...this.scan.frames.values()].find((g) => g.outer === f.at && g.slot === index && g.name === "Options");
    const end = f.parts[index]!.end;
    if (!call || call.close === undefined || this.text.slice(call.close + 1, end).trim()) return "*";
    return literalMethod(this.value(call, "method"), false) ?? "*";
  }

  /**
   * The method of a `URLRequest(url:)`: GET where it is handed on as it is, or held in a `let`; where a `var` holds it,
   * the one `httpMethod` (or Alamofire's `method`) assignment its block makes before any other use of it, GET where it
   * makes none. A request used before its method is set, passed `inout`, assigned again, given a method more than once
   * or in a nested block, is `*`.
   */
  private urlRequestMethod(f: Frame): string {
    const code = this.code();
    const callee = f.callee ?? f.at;
    const declared = /(?:^|[\s;{}(])(var|let)\s+([A-Za-z_]\w*)\s*(?::\s*URLRequest\s*)?=\s*$/.exec(code.slice(Math.max(0, callee - 200), callee));
    if (!declared) {
      const outer = f.outer !== undefined ? this.scan.frames.get(f.outer) : undefined;
      return outer?.open === "(" && outer.name !== undefined ? "GET" : "*";
    }
    if (declared[1] === "let") return "GET";
    const name = declared[2]!;
    const block = this.enclosingBlock(f.at);
    const end = block?.close ?? code.length;
    const rest = code.slice(f.close ?? end, end);
    const offset = f.close ?? end;
    const uses = [...rest.matchAll(new RegExp(`(?<![\\w$.])(&?)${escapeRegExp(name)}(?![\\w$])(\\s*\\.\\s*(?:httpMethod|method)\\s*=(?!=)\\s*([^\\n;]*)|\\s*=(?!=))?`, "g"))];
    let method = "GET";
    let set = 0;
    let used = false;
    for (const u of uses) {
      if (u[1] || (u[2] && u[3] === undefined)) return "*";
      if (u[3] === undefined) {
        used = true;
        continue;
      }
      // A request sent before its method is set is sent with the one it had then.
      if (used || ++set > 1 || this.enclosingBlock(offset + u.index) !== block) return "*";
      // The value as written: the code searched has its strings blanked.
      const from = offset + u.index + u[0].length - u[3].length;
      const value = this.text.slice(from, from + u[3].length).trim();
      method = literalMethod(value, true) ?? swiftMethod(value) ?? "*";
    }
    return method;
  }

  /**
   * Whether a Go method call is made on net/http's `DefaultClient` or on a name the file declares an `http.Client`
   * (`client := &http.Client{}`, `var client = http.Client{...}`, `client *http.Client` in a parameter or a field).
   */
  private goClient(f: Frame, http: string): boolean {
    if (f.dot !== undefined && new RegExp(`(?<![\\w.])${escapeRegExp(http)}\\s*\\.\\s*DefaultClient\\s*$`).test(this.code().slice(Math.max(0, f.dot - 200), f.dot))) return true;
    const receiver = f.receiver;
    if (receiver === undefined) return false;
    const name = escapeRegExp(receiver);
    const type = `${escapeRegExp(http)}\\s*\\.\\s*Client\\b`;
    return new RegExp(`(?<![\\w.])${name}\\s*(?::=|=)\\s*&?\\s*${type}\\s*\\{|(?<![\\w.])${name}\\s+\\*?\\s*${type}`).test(this.code());
  }

  /** Go's method argument: a literal, or the `MethodX` constant of net/http or resty. */
  private goMethod(text: string | undefined): string {
    if (text === undefined) return "*";
    const constant = /^([A-Za-z_]\w*)\s*\.\s*Method([A-Z][a-z]+)$/.exec(text);
    if (constant) {
      const [, pkg, method] = constant;
      const known = pkg === this.goName("net/http") ? GO_HTTP_METHODS : pkg === this.goName("github.com/go-resty/resty/v2") || pkg === this.goName("resty.dev/v3") ? RESTY_METHODS : undefined;
      return known?.has(method!) ? method!.toUpperCase() : "*";
    }
    return literalMethod(text, true) ?? "*";
  }

  /** The text of a call's part (its argument) at `index`, trimmed; undefined where there is none. */
  private part(f: Frame, index: number): string | undefined {
    const p = f.parts[index];
    const text = p && this.text.slice(p.start, p.end).trim();
    return text || undefined;
  }

  /** The name a call's argument is given by (`method = "X"`, `method: .post`), if any. */
  private label(f: Frame, index: number): string | undefined {
    const p = f.parts[index];
    return p ? /^\s*([A-Za-z_]\w*)\s*(?::(?!:)|=(?!=))/.exec(this.text.slice(p.start, p.end))?.[1] : undefined;
  }

  /** The value of a call's argument named `name`, trimmed; undefined where none is. */
  private value(f: Frame, name: string): string | undefined {
    for (let i = 0; i < f.parts.length; i++) {
      if (this.label(f, i) !== name) continue;
      return this.part(f, i)!.replace(/^[A-Za-z_]\w*\s*(?::|=)\s*/, "");
    }
    return undefined;
  }

  private empty(f: Frame): boolean {
    return f.parts.length === 0;
  }

  /** The call a method call is made on, where it is a call's result: `a()` for `a().b()`, also across lines. */
  private previous(f: Frame): Frame | undefined {
    if (f.dot === undefined) return undefined;
    let i = f.dot - 1;
    while (i >= 0 && /\s/.test(this.text[i]!)) i--;
    const call = this.closesAt().get(i);
    return call?.name !== undefined ? call : undefined;
  }

  /** The method call made on a call's result: `b()` for `a().b()`, also across lines (gofmt's `a().` then `b()`). */
  private following(f: Frame): Frame | undefined {
    if (f.close === undefined) return undefined;
    const m = /^\s*(\?\.|\.)/.exec(this.text.slice(f.close + 1, f.close + 400));
    return m ? this.dotsAt().get(f.close + 1 + m[0].length - m[1]!.length) : undefined;
  }

  private closesAt(): Map<number, Frame> {
    if (!this.closes) {
      this.closes = new Map();
      for (const f of this.scan.frames.values()) if (f.open === "(" && f.close !== undefined) this.closes.set(f.close, f);
    }
    return this.closes;
  }

  private dotsAt(): Map<number, Frame> {
    if (!this.dots) {
      this.dots = new Map();
      for (const f of this.scan.frames.values()) if (f.dot !== undefined) this.dots.set(f.dot, f);
    }
    return this.dots;
  }

  /** The innermost bracket an offset is inside. */
  private innermost(at: number): Frame | undefined {
    let best: Frame | undefined;
    for (const f of this.scan.frames.values()) if (f.at < at && (f.close ?? Infinity) > at && (!best || f.at > best.at)) best = f;
    return best;
  }

  /** The innermost braces an offset is inside. */
  private enclosingBlock(at: number): Frame | undefined {
    let best: Frame | undefined;
    for (const f of this.scan.frames.values()) if (f.open === "{" && f.at < at && (f.close ?? Infinity) > at && (!best || f.at > best.at)) best = f;
    return best;
  }

  /** The code with each string literal's contents blanked, so a look-alike token in a string is not read as code. */
  private code(): string {
    this.masked ??= blankStrings(this.text, this.scan.strings);
    return this.masked;
  }

  /** Whether a Kotlin file imports one of the declarations named, by name or with its package's `*`, without renaming it. */
  private imports(names: RegExp): boolean {
    return new RegExp(`^\\s*import\\s+(?:${names.source})\\s*;?\\s*$`, "m").test(this.code());
  }

  /** The name a Go file refers to an imported package by: its own, or the one the import gives it. */
  private goName(path: string): string | undefined {
    if (!this.goNames) {
      this.goNames = new Map();
      const code = this.code();
      // `import "x"`, `import name "x"`, and each line of `import ( ... )`, where the code (not a string) has them.
      const specs: Array<[number, number]> = [];
      for (const m of code.matchAll(/(?:^|\n)[ \t]*import[ \t]*(\(([^)]*)\)|[^\n]*)/g)) {
        const at = (m.index ?? 0) + m[0].length - m[1]!.length;
        if (m[2] === undefined) specs.push([at, at + m[1]!.length]);
        else {
          let from = at + 1;
          for (const line of m[2].split("\n")) {
            specs.push([from, from + line.length]);
            from += line.length + 1;
          }
        }
      }
      for (const [from, to] of specs) {
        const s = /^\s*([A-Za-z_]\w*|\.)?\s*"([^"\n]*)"\s*;?\s*$/.exec(this.text.slice(from, to));
        if (!s) continue;
        const name = s[1] ?? GO_PACKAGES.get(s[2]!);
        if (name && name !== "." && name !== "_") this.goNames.set(s[2]!, name);
      }
    }
    return this.goNames.get(path);
  }

  /** The prefixes a Dart file imports a library under: `""` where it imports it without one. */
  private dartPrefix(uri: string): string[] {
    if (!this.dartPrefixes) {
      this.dartPrefixes = new Map();
      const code = this.code();
      for (const m of code.matchAll(/(?:^|\n)\s*import\s+(['"])[^'"\n]*\1([^;]*);/g)) {
        const at = (m.index ?? 0) + m[0].indexOf(m[1]!);
        const quoted = this.text.slice(at + 1, this.text.indexOf(m[1]!, at + 1));
        // A `show` or `hide` combinator narrows the names; such an import is not read.
        const rest = m[2]!;
        if (/\b(?:show|hide)\b/.test(rest)) continue;
        const prefix = /^\s*(?:deferred\s+)?as\s+([A-Za-z_]\w*)\s*$/.exec(rest)?.[1] ?? (rest.trim() ? undefined : "");
        if (prefix === undefined) continue;
        this.dartPrefixes.set(quoted, [...(this.dartPrefixes.get(quoted) ?? []), prefix]);
      }
    }
    return this.dartPrefixes.get(uri) ?? [];
  }

  /** Whether a Python name is the `requests` or `httpx` module, by the name an `import` gives it. */
  private pythonModule(name: string): boolean {
    return this.python().modules.has(name);
  }

  /** Whether a bare Python name is the `Request` of `requests` or `httpx`, imported under it. */
  private pythonImported(name: string): boolean {
    return this.python().names.get(name) === "Request";
  }

  private python(): { modules: Map<string, string>; names: Map<string, string> } {
    if (!this.pythonNames) {
      const modules = new Map<string, string>();
      const names = new Map<string, string>();
      const code = this.code();
      for (const m of code.matchAll(/(?:^|\n)[ \t]*import[ \t]+([^\n]+)/g))
        for (const item of m[1]!.split(",")) {
          const i = /^\s*(requests|httpx)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(item);
          if (i) modules.set(i[2] ?? i[1]!, i[1]!);
        }
      for (const m of code.matchAll(/(?:^|\n)[ \t]*from[ \t]+(requests|httpx)[ \t]+import[ \t]+(?:\(([^)]*)\)|([^\n]+))/g))
        for (const item of (m[2] ?? m[3]!).split(",")) {
          const i = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(item);
          if (i) names.set(i[2] ?? i[1]!, i[1]!);
        }
      this.pythonNames = { modules, names };
    }
    return this.pythonNames;
  }
}

const STOP = Symbol("stop");

/** Methods a library's constant or a literal may name. */
const KNOWN = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT", "QUERY"]);

/** Names of methods, called on a receiver, that send the request with that method. */
const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/** Names a call's URL argument is given by. */
const URL_LABELS = new Set(["url", "urlString", "uri", "requestUri", "path"]);

const RETROFIT_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const REFIT_VERBS = new Set(["Get", "Post", "Put", "Patch", "Delete", "Head", "Options"]);

/** RestTemplate's methods named for the method they send, the URL first (Spring Framework, RestTemplate). */
const REST_TEMPLATE = new Map([
  ["getForObject", "GET"],
  ["getForEntity", "GET"],
  ["headForHeaders", "HEAD"],
  ["postForObject", "POST"],
  ["postForEntity", "POST"],
  ["postForLocation", "POST"],
  ["patchForObject", "PATCH"],
  ["optionsForAllow", "OPTIONS"],
]);

/** The constants of Spring's `HttpMethod`. */
const SPRING_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "QUERY"]);

/** `Request.Builder`'s calls that set no method (OkHttp, Request.Builder), and those that do. */
const OKHTTP_SETTERS = new Set(["url", "header", "addHeader", "removeHeader", "headers", "cacheControl", "tag", "cacheUrlOverride"]);
const OKHTTP_METHODS = new Map([
  ["get", "GET"],
  ["head", "HEAD"],
  ["post", "POST"],
  ["put", "PUT"],
  ["patch", "PATCH"],
  ["delete", "DELETE"],
]);

/** Ktor's `request` and `submitForm`, imported by name or with their package. */
const KTOR_REQUEST = /io\.ktor\.client\.request\.(?:request|\*)/;
const KTOR_FORMS = /io\.ktor\.client\.request\.forms\.(?:submitForm|\*)/;

/** The name each Go package read here declares, which an import without a name refers to it by. */
const GO_PACKAGES = new Map([
  ["net/http", "http"],
  ["github.com/go-resty/resty/v2", "resty"],
  ["resty.dev/v3", "resty"],
]);
/** net/http's `MethodX` constants, and resty's. */
const GO_HTTP_METHODS = new Set(["Get", "Head", "Post", "Put", "Patch", "Delete", "Connect", "Options", "Trace"]);
const RESTY_METHODS = new Set(["Get", "Post", "Put", "Delete", "Patch", "Head", "Options", "Trace"]);

/** URLSession's methods that load a URL given `from:`. */
const URL_SESSION_GETS = new Set(["data", "bytes", "download"]);

/** package:http's requests built with a method and a URL. */
const DART_REQUESTS = new Set(["Request", "MultipartRequest", "StreamedRequest"]);

/** HttpClient's methods, and those System.Net.Http.Json adds, by the method each sends. */
const DOTNET_METHODS = new Map([
  ["GetAsync", "GET"],
  ["GetStringAsync", "GET"],
  ["GetStreamAsync", "GET"],
  ["GetByteArrayAsync", "GET"],
  ["GetFromJsonAsync", "GET"],
  ["GetFromJsonAsAsyncEnumerable", "GET"],
  ["PostAsync", "POST"],
  ["PostAsJsonAsync", "POST"],
  ["PutAsync", "PUT"],
  ["PutAsJsonAsync", "PUT"],
  ["PatchAsync", "PATCH"],
  ["PatchAsJsonAsync", "PATCH"],
  ["DeleteAsync", "DELETE"],
  ["DeleteFromJsonAsync", "DELETE"],
]);

/** .NET's `HttpMethod` properties. */
const DOTNET_HTTP_METHODS = new Set(["Get", "Post", "Put", "Patch", "Delete", "Head", "Options", "Trace", "Connect"]);

/**
 * The method a string literal states: as written where the library sends it so (`exact`), else in any case, as the
 * library upper-cases it. Undefined for anything but a lone literal of a known method.
 */
function literalMethod(text: string | undefined, exact: boolean): string | undefined {
  const m = text === undefined ? undefined : /^(["'])([A-Za-z]+)\1$/.exec(text.trim());
  if (!m) return undefined;
  const method = exact ? m[2]! : m[2]!.toUpperCase();
  return KNOWN.has(method) ? method : undefined;
}

/** Alamofire's `HTTPMethod` written as `.post` or `HTTPMethod.post`. */
function swiftMethod(text: string): string | undefined {
  const m = /^(?:HTTPMethod)?\s*\.\s*([a-z]+)$/.exec(text.trim());
  const method = m?.[1]?.toUpperCase();
  return method && KNOWN.has(method) ? method : undefined;
}

/** .NET's method argument: an `HttpMethod` property, or `new HttpMethod("X")`. */
function dotnetMethod(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const property = /^(?:System\s*\.\s*Net\s*\.\s*Http\s*\.\s*)?HttpMethod\s*\.\s*([A-Z][a-z]+)$/.exec(text)?.[1];
  if (property) return DOTNET_HTTP_METHODS.has(property) ? property.toUpperCase() : undefined;
  const created = /^new\s+HttpMethod\s*\(\s*("[^"]*")\s*\)$/.exec(text)?.[1];
  return literalMethod(created, true);
}

/** Code with the contents of each string literal blanked (quotes, newlines and offsets kept). */
export function blankStrings(text: string, strings: Array<[number, number]>): string {
  const out = text.split("");
  for (const [start, end] of strings) for (let k = start + 1; k < end - 1; k++) if (out[k] !== "\n") out[k] = " ";
  return out.join("");
}

function escapeRegExp(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
