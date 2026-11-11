/**
 * ASP.NET Core's route template syntax, as `RoutePatternParser` and `RouteParameterParser` read it
 * (aspnetcore src/Http/Routing/src/Patterns), and what each form means for the paths a route serves:
 *
 * - A leading `/` or `~/` is left out; segments are separated by `/`, and a `/` at the end ends the last segment.
 * - `{name}` is a parameter, `{*name}` and `{**name}` a catch-all that takes the rest of the path (the last part of
 *   the last segment only), `{name?}` an optional one, `{name=value}` one with a default, `{name:c1:c2(arg)}` one with
 *   constraints; `{{` and `}}` are braces as text.
 * - A segment may hold several parts (`{filename}.{ext}`); only its last parameter may be optional, after a `.`.
 * - A segment whose parameter is optional, has a default or is a catch-all may be left out with every segment after it
 *   (`DfaMatcherBuilder.HasAdditionalRequiredSegments`); an optional last part leaves out the `.` before it too.
 *
 * Constraints are the ones `RouteOptions` maps by default (src/Http/Routing/src/Constraints). A route's place among the
 * routes a request fits is its precedence (`RoutePrecedence.ComputeInbound`): a digit per segment, a literal 1, a
 * constrained parameter or a segment of several parts 2, a parameter 3, a constrained catch-all 4, a catch-all 5.
 */

export interface PatternParameter {
  name: string;
  catchAll: boolean;
  optional: boolean;
  default?: string;
  /** Each constraint as written: `int`, `range(1,12)`, `regex(^\d+$)`. */
  constraints: string[];
  /**
   * The value the parameter is matched as, as a literal (a controller's `{controller}` and `{action}`, which
   * `DefaultRoutePatternTransformer.SubstituteRequiredValues` gives the action's values).
   */
  required?: string;
}

export type PatternPart = { literal: string } | { parameter: PatternParameter };

export type PatternSegment = PatternPart[];

/** The segments of a route template, or why ASP.NET Core rejects it. */
export function parsePattern(raw: string): { segments: PatternSegment[] } | { error: string } {
  let text = raw;
  if (text.startsWith("~/")) text = text.slice(2);
  else if (text.startsWith("/")) text = text.slice(1);
  else if (text.startsWith("~")) return { error: "starts with ~ without /" };
  const segments: PatternSegment[] = [];
  const names = new Set<string>();
  let i = 0;
  while (i < text.length) {
    if (text[i] === "/") return { error: "has two / in a row" };
    const parts: PatternPart[] = [];
    while (i < text.length && text[i] !== "/") {
      if (text[i] === "{" && text[i + 1] !== "{") {
        // A parameter: up to the `}` not doubled, `{{` and `}}` inside it standing for braces.
        let j = i + 1;
        for (;;) {
          if (j >= text.length) return { error: "has a { without its }" };
          if (text[j] === "{") {
            if (text[j + 1] !== "{") return { error: "has a { inside a parameter" };
            j += 2;
            continue;
          }
          if (text[j] === "}") {
            if (text[j + 1] === "}") {
              j += 2;
              continue;
            }
            break;
          }
          j++;
        }
        const inside = text.slice(i + 1, j).replaceAll("}}", "}").replaceAll("{{", "{");
        i = j + 1;
        if (!inside) return { error: "has an empty parameter" };
        const parameter = parseParameter(inside);
        if (inside.startsWith("*") && inside.endsWith("?")) return { error: "has an optional catch-all" };
        if (parameter.optional && parameter.default !== undefined) return { error: "has an optional parameter with a default" };
        if (!parameter.name || /[/{}?*]/.test(parameter.name)) return { error: `has a parameter name ${JSON.stringify(parameter.name)} that is not valid` };
        if (names.has(parameter.name.toLowerCase())) return { error: `repeats the parameter ${parameter.name}` };
        names.add(parameter.name.toLowerCase());
        parts.push({ parameter });
        continue;
      }
      // A literal, up to the next parameter or `/`.
      let literal = "";
      while (i < text.length && text[i] !== "/") {
        if (text[i] === "{") {
          if (text[i + 1] !== "{") break;
          literal += "{";
          i += 2;
          continue;
        }
        if (text[i] === "}") {
          if (text[i + 1] !== "}") return { error: "has a } without its {" };
          literal += "}";
          i += 2;
          continue;
        }
        literal += text[i];
        i++;
      }
      if (literal.includes("?")) return { error: `has a literal with ? (${literal})` };
      parts.push({ literal });
    }
    if (i < text.length) i++;
    const error = segmentError(parts);
    if (error) return { error };
    segments.push(parts);
  }
  const catchAll = segments.findIndex((s) => s.some((p) => "parameter" in p && p.parameter.catchAll));
  if (catchAll >= 0) {
    const seg = segments[catchAll]!;
    const last = seg[seg.length - 1]!;
    if (catchAll !== segments.length - 1 || !("parameter" in last) || !last.parameter.catchAll) return { error: "has a catch-all that is not its last part" };
  }
  return { segments };
}

function segmentError(parts: PatternPart[]): string | undefined {
  if (parts.length > 1 && parts.some((p) => "parameter" in p && p.parameter.catchAll)) return "has a catch-all in a segment of several parts";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!("parameter" in p) || !p.parameter.optional || parts.length === 1) continue;
    const before = parts[i - 1];
    if (i !== parts.length - 1 || !before || !("literal" in before) || before.literal !== ".") return "has an optional parameter that is not the last part after a .";
  }
  for (let i = 1; i < parts.length; i++) if ("parameter" in parts[i]! && "parameter" in parts[i - 1]!) return "has two parameters in a row";
  return undefined;
}

/** `RouteParameterParser.ParseRouteParameter`: a parameter's name, kind, constraints and default. */
export function parseParameter(text: string): PatternParameter {
  let start = 0;
  let end = text.length - 1;
  let catchAll = false;
  let optional = false;
  if (text.startsWith("**")) {
    catchAll = true;
    start = 2;
  } else if (text.startsWith("*")) {
    catchAll = true;
    start = 1;
  }
  if (text[end] === "?") {
    optional = true;
    end--;
  }
  let i = start;
  let name = "";
  while (i <= end) {
    const c = text[i];
    if ((c === ":" || c === "=") && i !== start) {
      name = text.slice(start, i);
      i--;
      break;
    } else if (i === end) name = text.slice(start, i + 1);
    i++;
  }
  // The constraints: `:name` or `:name(args)`, where args run to the `)` before a `:`, `=` or the end.
  const constraints: string[] = [];
  let state: "start" | "name" | "paren" | "end" = "start";
  let from = i;
  do {
    const c = i > end ? undefined : text[i];
    if (state === "start") {
      if (c === undefined) state = "end";
      else if (c === ":") {
        state = "name";
        from = i + 1;
      } else if (c === "(") state = "paren";
      else if (c === "=") {
        state = "end";
        i--;
      }
    } else if (state === "paren") {
      if (c === undefined) {
        state = "end";
        constraints.push(text.slice(from, i));
      } else if (c === ")") {
        const next = i + 1 > end ? undefined : text[i + 1];
        if (next === undefined) {
          state = "end";
          constraints.push(text.slice(from, i + 1));
        } else if (next === ":") {
          state = "start";
          constraints.push(text.slice(from, i + 1));
          from = i + 1;
        } else if (next === "=") {
          state = "end";
          constraints.push(text.slice(from, i + 1));
        }
      } else if (c === ":" || c === "=") {
        const closing = text.indexOf(")", i + 1);
        if (closing === -1) {
          constraints.push(text.slice(from, i));
          if (c === ":") {
            state = "name";
            from = i + 1;
          } else {
            state = "end";
            i--;
          }
        } else i = closing;
      }
    } else if (state === "name") {
      if (c === undefined) {
        state = "end";
        if (i > from) constraints.push(text.slice(from, i));
      } else if (c === ":") {
        if (i > from) constraints.push(text.slice(from, i));
        from = i + 1;
      } else if (c === "(") state = "paren";
      else if (c === "=") {
        state = "end";
        if (i > from) constraints.push(text.slice(from, i));
        i--;
      }
    }
    i++;
  } while (state !== "end");
  const out: PatternParameter = { name, catchAll, optional, constraints };
  if (i <= end && text[i] === "=") out.default = text.slice(i + 1, end + 1);
  return out;
}

/** A path a template serves, with what it asks more of the parameters in it than their constraints do. */
export interface ServedPath {
  path: string;
  /**
   * Parameters a form takes only some values for: the one before an optional `.{ext?}` the template leaves out takes
   * only a value the form with it does not (`RoutePatternMatcher.MatchComplexSegment` tries that first), by this regular
   * expression, or by one atlas does not write (undefined).
   */
  narrowed: Record<string, string | undefined>;
}

/**
 * The paths a parsed template serves, in atlas's form: each parameter `{name}`, a catch-all `{*name}` (which takes the
 * path without it too), and each form that leaves out the trailing segments ASP.NET Core lets a request leave out, the
 * shortest first. A parameter with a `required` value is written as that value (a conventional route's `{controller}`
 * and `{action}`); a parameter so replaced keeps a default only where it equals its value, and may then be left out like
 * any with a default.
 */
export function servedPaths(segments: PatternSegment[]): ServedPath[] {
  const omittable = (seg: PatternSegment): boolean => {
    if (seg.length !== 1) return false;
    const p = seg[0]!;
    return "parameter" in p && (p.parameter.optional || p.parameter.catchAll || p.parameter.default !== undefined);
  };
  const text = (parts: PatternPart[]) =>
    parts.map((p) => ("literal" in p ? p.literal : p.parameter.required ?? (p.parameter.catchAll ? `{*${p.parameter.name}}` : `{${p.parameter.name}}`))).join("");
  const forms = (seg: PatternSegment): ServedPath[] => {
    const last = seg[seg.length - 1]!;
    if (seg.length > 2 && "parameter" in last && last.parameter.optional) {
      // `{filename}.{ext?}` serves `{filename}` too, for a segment the form with `.{ext}` does not take and that does
      // not end with the `.`: of `{p}.{ext?}`, one with no `.` but maybe a first one.
      const before = seg.slice(0, -2);
      const lone = before.length === 1 && "parameter" in before[0]! && !before[0].parameter.required ? before[0].parameter.name : undefined;
      const narrowed = Object.create(null) as Record<string, string | undefined>;
      if (lone !== undefined) narrowed[lone] = "\\.?[^.]+";
      else for (const p of before) if ("parameter" in p && !p.parameter.required) narrowed[p.parameter.name] = undefined;
      return [{ path: text(before), narrowed }, { path: text(seg), narrowed: {} }];
    }
    return [{ path: text(seg), narrowed: {} }];
  };
  const out: ServedPath[] = [];
  const last = segments[segments.length - 1];
  const catchAll = !!last && last.length === 1 && "parameter" in last[0]! && last[0].parameter.catchAll;
  for (let cut = 0; cut <= segments.length; cut++) {
    if (!segments.slice(cut).every(omittable)) continue;
    // A catch-all takes the path without it as written, `{*rest}`: no form leaves only it out.
    if (catchAll && cut === segments.length - 1) continue;
    let paths: ServedPath[] = [{ path: "", narrowed: {} }];
    for (const seg of segments.slice(0, cut)) paths = paths.flatMap((p) => forms(seg).map((f) => ({ path: `${p.path}/${f.path}`, narrowed: { ...p.narrowed, ...f.narrowed } })));
    out.push(...paths.map((p) => ({ ...p, path: p.path || "/" })));
  }
  const seen = new Set<string>();
  return out.filter((p) => !seen.has(p.path) && !!seen.add(p.path));
}

/** `RoutePrecedence.ComputeInboundPrecedenceDigit` for each segment. */
export function precedence(segments: PatternSegment[]): number[] {
  return segments.map((seg) => {
    if (seg.length > 1) return 2;
    const p = seg[0]!;
    // A parameter with a required value is matched as a literal (`ComputeInboundPrecedenceDigit(RoutePattern, ...)`).
    if ("literal" in p || p.parameter.required) return 1;
    const digit = p.parameter.catchAll ? 5 : 3;
    return p.parameter.constraints.length ? digit - 1 : digit;
  });
}

/** The parameters of a template, in order. */
export function parameters(segments: PatternSegment[]): PatternParameter[] {
  return segments.flatMap((s) => s.flatMap((p) => ("parameter" in p ? [p.parameter] : [])));
}

/**
 * The regular expression (JavaScript) that takes exactly the values a parameter's constraints accept, or undefined
 * where a constraint is not read: one whose test is a number's range or a parse of a type atlas does not repeat
 * (`min`, `range`, `datetime`, `decimal`, `guid`), one the application registers, or a `regex` beyond the syntax both
 * engines read alike. A parameter with no constraint takes any value: `null`.
 */
export function constraintPattern(constraints: string[]): string | null | undefined {
  if (!constraints.length) return null;
  const each = constraints.map(constraintRegex);
  if (each.some((r) => r === undefined)) return undefined;
  const list = each as string[];
  if (list.length === 1) return list[0]!;
  return `${list.map((r) => `(?=(?:${r})$)`).join("")}[\\s\\S]*`;
}

const WHITE = "[\\t-\\r ]*";

/**
 * The decimal numbers from 0 to `max` (no leading zeros), as a regular expression: each length below `max`'s, then
 * each digit of `max` in turn with any digits after it, and `max` itself.
 */
function upTo(max: string): string {
  const alts: string[] = [];
  if (max.length > 1) alts.push(`[0-9]`, ...(max.length > 2 ? [`[1-9][0-9]{1,${max.length - 2}}`] : []));
  for (let i = 0; i < max.length; i++) {
    const d = Number(max[i]);
    const low = i === 0 && max.length > 1 ? 1 : 0;
    if (d > low) alts.push(`${max.slice(0, i)}[${low}-${d - 1}]${max.length - i - 1 ? `[0-9]{${max.length - i - 1}}` : ""}`);
  }
  alts.push(max);
  return `(?:${alts.join("|")})`;
}

/**
 * `int.TryParse` and `long.TryParse` with `NumberStyles.Integer` and the invariant culture: white space (U+0009 to
 * U+000D and the space) before and after, a sign, any number of leading zeros, a value in the type's range, and NUL
 * characters at the end, which .NET's number parsing allows.
 */
function integer(max: string): string {
  const min = (BigInt(max) + 1n).toString();
  return `${WHITE}(?:[-+]?0*${upTo(max)}|-0*${min})${WHITE}\\x00*`;
}

function constraintRegex(constraint: string): string | undefined {
  const m = /^([A-Za-z]\w*)(?:\(([\s\S]*)\))?$/.exec(constraint);
  if (!m) return undefined;
  const name = m[1]!.toLowerCase();
  const arg = m[2];
  const counts = arg?.split(",").map((a) => a.trim());
  const whole = (s: string | undefined) => (s !== undefined && /^[0-9]+$/.test(s) && Number(s) <= 2 ** 31 - 1 ? Number(s) : undefined);
  switch (name) {
    case "int":
      return arg === undefined ? integer("2147483647") : undefined;
    case "long":
      return arg === undefined ? integer("9223372036854775807") : undefined;
    case "alpha":
      // AlphaRouteConstraint's `^[A-Za-z]*$`, which has no IgnoreCase; `$` also takes a last `\n`.
      return arg === undefined ? "[A-Za-z]*\\n?" : undefined;
    case "required":
      return arg === undefined ? "[\\s\\S]+" : undefined;
    case "minlength": {
      const n = counts?.length === 1 ? whole(counts[0]) : undefined;
      return n === undefined ? undefined : `[\\s\\S]{${n},}`;
    }
    case "maxlength": {
      const n = counts?.length === 1 ? whole(counts[0]) : undefined;
      return n === undefined ? undefined : `[\\s\\S]{0,${n}}`;
    }
    case "length": {
      const [a, b] = [whole(counts?.[0]), whole(counts?.[1])];
      if (counts?.length === 1 && a !== undefined) return `[\\s\\S]{${a}}`;
      return counts?.length === 2 && a !== undefined && b !== undefined && a <= b ? `[\\s\\S]{${a},${b}}` : undefined;
    }
    case "regex":
      return arg === undefined ? undefined : dotnetRegex(arg);
    default:
      return undefined;
  }
}

/**
 * A .NET regular expression as `RegexRouteConstraint` tests it (`IsMatch` with `IgnoreCase` and `CultureInvariant`, so
 * anywhere in the value and in either case), written for JavaScript, or undefined where it uses syntax the two engines
 * read differently or atlas does not translate: `\d`, `\w`, `\s` and `\b` (Unicode in .NET), backreferences, inline
 * options, atomic groups, class subtraction. `.` takes any character but `\n`, `$` the end or a `\n` before it, as in
 * .NET. An ASCII letter takes both its cases, and `k` the Kelvin sign .NET's case table pairs it with; a character
 * beyond ASCII, whose case pairs atlas does not repeat, is not translated.
 */
export function dotnetRegex(source: string): string | undefined {
  let out = "";
  let i = 0;
  const caseless = (ch: string): string => {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (!/^[a-z]$/.test(lower)) return ch;
    return `${lower}${upper}${lower === "k" ? "\\u212A" : ""}`;
  };
  const escapeChar = (ch: string) => (/[\\^$.*+?()[\]{}|/-]/.test(ch) ? `\\${ch}` : ch);
  /** One character an escape stands for, at `j` (after the backslash), or undefined for a class or anything else. */
  const escaped = (j: number): { ch: string; end: number } | undefined => {
    const c = source[j];
    if (c === undefined) return undefined;
    const simple: Record<string, string> = { t: "\t", n: "\n", r: "\r", f: "\f", v: "\v", a: "\x07", e: "\x1b" };
    if (Object.hasOwn(simple, c)) return { ch: simple[c]!, end: j + 1 };
    if (c === "x" && /^[0-9A-Fa-f]{2}$/.test(source.slice(j + 1, j + 3))) return { ch: String.fromCharCode(parseInt(source.slice(j + 1, j + 3), 16)), end: j + 3 };
    if (c === "u" && /^[0-9A-Fa-f]{4}$/.test(source.slice(j + 1, j + 5))) return { ch: String.fromCharCode(parseInt(source.slice(j + 1, j + 5), 16)), end: j + 5 };
    if (/[^\w\s]/.test(c)) return { ch: c, end: j + 1 };
    return undefined;
  };
  const literal = (ch: string): string | undefined => {
    if (ch.charCodeAt(0) > 0x7f) return undefined;
    const both = caseless(ch);
    return both === ch ? escapeChar(ch) : `[${both}]`;
  };
  const code = (ch: string) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\\") {
      const next = source[i + 1];
      if (next === "A") out += "^";
      else if (next === "z") out += "$";
      else if (next === "Z") out += "(?=\\n?$)";
      else {
        const e = escaped(i + 1);
        if (!e) return undefined;
        if (e.ch.charCodeAt(0) > 0x7f) return undefined;
        out += /[a-zA-Z]/.test(e.ch) ? literal(e.ch)! : code(e.ch);
        i = e.end;
        continue;
      }
      i += 2;
      continue;
    }
    if (c === "[") {
      // A class: characters, ranges and escapes of one character; each ASCII letter in it with its other case.
      let j = i + 1;
      let negated = false;
      if (source[j] === "^") {
        negated = true;
        j++;
      }
      const items: Array<[number, number]> = [];
      let first = true;
      for (;;) {
        if (j >= source.length) return undefined;
        let ch = source[j]!;
        if (ch === "]" && !first) break;
        first = false;
        if (ch === "[") return undefined;
        let end = j + 1;
        if (ch === "\\") {
          const e = escaped(j + 1);
          if (!e) return undefined;
          ch = e.ch;
          end = e.end;
        }
        let to = ch;
        if (source[end] === "-" && source[end + 1] !== "]" && end + 1 < source.length) {
          let k = end + 1;
          to = source[k]!;
          if (to === "[") return undefined;
          k++;
          if (to === "\\") {
            const e = escaped(k);
            if (!e) return undefined;
            to = e.ch;
            k = e.end;
          }
          end = k;
        }
        if (to.charCodeAt(0) < ch.charCodeAt(0) || to.charCodeAt(0) > 0x7f) return undefined;
        items.push([ch.charCodeAt(0), to.charCodeAt(0)]);
        j = end;
      }
      const extra: Array<[number, number]> = [];
      for (const [a, b] of items) {
        for (const [lo, hi, shift] of [[65, 90, 32], [97, 122, -32]] as const) {
          const x = Math.max(a, lo);
          const y = Math.min(b, hi);
          if (x <= y) extra.push([x + shift, y + shift]);
        }
        const has = (n: number) => a <= n && n <= b;
        if (has(75) || has(107)) extra.push([0x212a, 0x212a]);
      }
      const body = [...items, ...extra].map(([a, b]) => (a === b ? code(String.fromCharCode(a)) : `${code(String.fromCharCode(a))}-${code(String.fromCharCode(b))}`)).join("");
      out += `[${negated ? "^" : ""}${body}]`;
      i = j + 1;
      continue;
    }
    if (c === "(") {
      if (source[i + 1] !== "?") {
        out += "(?:";
        i++;
        continue;
      }
      const look = /^\(\?(?::|=|!|<=|<!)/.exec(source.slice(i));
      if (look) {
        out += look[0];
        i += look[0].length;
        continue;
      }
      const named = /^\(\?<[A-Za-z_]\w*>/.exec(source.slice(i));
      if (named) {
        out += "(?:";
        i += named[0].length;
        continue;
      }
      return undefined;
    }
    if (c === ".") {
      out += "[^\\n]";
      i++;
      continue;
    }
    if (c === "$") {
      out += "(?=\\n?$)";
      i++;
      continue;
    }
    if (c === "{") {
      const q = /^\{\d+(?:,\d*)?\}\??/.exec(source.slice(i));
      if (!q) return undefined;
      out += q[0];
      i += q[0].length;
      continue;
    }
    if ("^)|*+?".includes(c)) {
      out += c;
      i++;
      continue;
    }
    if (c === "]" || c === "}") return undefined;
    const lit = literal(c);
    if (lit === undefined) return undefined;
    out += lit;
    i++;
  }
  try {
    new RegExp(out);
  } catch {
    return undefined;
  }
  return `[\\s\\S]*?(?:${out})[\\s\\S]*`;
}
