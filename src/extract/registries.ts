import { isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from "yaml";
import type { ActiveList, Config } from "../config.js";
import type { Coverage, Place, RegistryEntry } from "../model.js";
import { lineOf, select, type Source } from "../source.js";
import { addCoverage } from "./coverage.js";

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function occurrences(source: Source, files: string[], tokens: string[]): Place[] {
  const re = new RegExp(`(?<![A-Za-z0-9_])(?:${tokens.map(escape).join("|")})(?![A-Za-z0-9_])`);
  const out: Place[] = [];
  for (const file of files) {
    const text = source.read(file);
    if (text === undefined) continue;
    const m = re.exec(text);
    if (m) out.push({ file, line: lineOf(text, m.index) });
  }
  return out;
}

interface Keyed {
  key: string;
  at: Place;
}

function keysFrom(source: Source, file: string, pattern: string | undefined, field: string | undefined): Keyed[] {
  const text = source.read(file);
  if (text === undefined) return [];
  const re = pattern ? new RegExp(pattern) : undefined;
  const out: Keyed[] = [];
  // Each value is located by its own node, so an earlier mention of the same text or an escape does not move it.
  const take = (node: unknown) => {
    const valueNode = isScalar(node) ? node : field && isMap(node) ? (node.get(field, true) as YamlNode | undefined) : undefined;
    const raw = isScalar(valueNode) ? valueNode.value : undefined;
    if (typeof raw !== "string") return;
    const key = re ? re.exec(raw)?.[1] : raw;
    if (!key) return;
    out.push({ key, at: { file, line: valueNode?.range ? lineOf(text, valueNode.range[0]) : 1 } });
  };
  try {
    JSON.parse(text);
    const root = parseDocument(text).contents;
    if (isSeq(root)) root.items.forEach(take);
    else if (isMap(root)) {
      for (const pair of root.items) {
        if (isSeq(pair.value)) pair.value.items.forEach(take);
        else take(pair.value);
      }
    }
  } catch {
    if (!re) return out;
    // The key's own line: a pattern that starts with the line break before it would otherwise place it a line early.
    const global = new RegExp(re.source, "gd");
    for (const m of text.matchAll(global)) if (m[1]) out.push({ key: m[1], at: { file, line: lineOf(text, m.indices?.[1]?.[0] ?? m.index ?? 0) } });
  }
  return out;
}

function activeKeys(source: Source, active: ActiveList | { files: string; pattern?: string; field?: string }): { files: number; keys: Keyed[] } {
  const files = ("file" in active ? [active.file] : select(source, [active.files], [])).filter((f) => source.read(f) !== undefined);
  return { files: files.length, keys: files.flatMap((f) => keysFrom(source, f, active.pattern, active.field)) };
}

/** `coverage` gets one `registries <name>` entry per registry: the active files read and the entries they list. */
export function extractRegistries(source: Source, config: Config, coverage: Coverage[] = []): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  for (const reg of config.registries) {
    const seen = new Set<string>();
    const producerFiles = select(source, reg.producers, config.exclude);
    const consumerFiles = select(source, reg.consumers, config.exclude);
    const active = activeKeys(source, reg.active);
    for (const { key, at } of active.keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `${reg.name}:${key}`,
        registry: reg.name,
        key,
        at,
        producers: occurrences(source, producerFiles, [key]),
        consumers: occurrences(source, consumerFiles, [key]),
      });
    }
    addCoverage(coverage, `registries ${reg.name}`, active.files, seen.size);
  }
  return out;
}
