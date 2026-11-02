import type { ActiveList, Config } from "../config.js";
import type { ContractVersion, Place, RegistryEntry } from "../model.js";
import { lineOf, select, type Source } from "../source.js";

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
  const take = (value: unknown) => {
    const raw = typeof value === "string" ? value : field && value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
    if (typeof raw !== "string") return;
    const key = re ? re.exec(raw)?.[1] : raw;
    if (!key) return;
    const index = text.indexOf(raw);
    out.push({ key, at: { file, line: index >= 0 ? lineOf(text, index) : 1 } });
  };
  try {
    const json = JSON.parse(text) as unknown;
    if (Array.isArray(json)) json.forEach(take);
    else if (json && typeof json === "object") Object.values(json as Record<string, unknown>).forEach((v) => (Array.isArray(v) ? v.forEach(take) : take(v)));
  } catch {
    if (!re) return out;
    const global = new RegExp(re.source, "g");
    for (const m of text.matchAll(global)) if (m[1]) out.push({ key: m[1], at: { file, line: lineOf(text, m.index ?? 0) } });
  }
  return out;
}

function activeKeys(source: Source, active: ActiveList | { files: string; pattern?: string; field?: string }): Keyed[] {
  const files = "file" in active ? [active.file] : select(source, [active.files], []);
  return files.flatMap((f) => keysFrom(source, f, active.pattern, active.field));
}

export function extractRegistries(source: Source, config: Config): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  for (const reg of config.registries) {
    const seen = new Set<string>();
    const producerFiles = select(source, reg.producers, config.exclude);
    const consumerFiles = select(source, reg.consumers, config.exclude);
    for (const { key, at } of activeKeys(source, reg.active)) {
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
  }
  return out;
}

const owner = (companion: RegExp | undefined, family: string): string => (companion && companion.exec(family)?.[1]) || family;

const pascal = (s: string): string => s.replace(/(^|[-_.])([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

export function extractVersions(source: Source, config: Config): ContractVersion[] {
  const out: ContractVersion[] = [];
  for (const spec of config.versions) {
    const re = new RegExp(spec.pattern);
    const companion = spec.companionOf ? new RegExp(spec.companionOf) : undefined;
    const isActive = (set: Set<string>, family: string, version: number, base: string): boolean =>
      set.has(`${family}-v${version}`) || set.has(base) || set.has(`${family}@${version}`);
    const versionFiles = select(source, [spec.files], []);
    const active = spec.active ? new Set(keysFrom(source, spec.active.file, spec.active.pattern, spec.active.field).map((k) => k.key)) : undefined;
    const referenceFiles = select(source, spec.references, [...config.exclude, spec.files]);
    const found = new Map<string, ContractVersion>();
    for (const file of versionFiles) {
      const base = file.split("/").pop()!;
      const m = re.exec(base);
      if (!m?.[1] || !m[2]) continue;
      const family = m[1];
      const version = Number(m[2]);
      const name = `${family}-v${version}`;
      if (found.has(name)) continue;
      found.set(name, {
        id: name,
        family,
        version,
        active: active ? isActive(active, family, version, base) || isActive(active, owner(companion, family), version, base.replace(family, owner(companion, family))) : undefined,
        at: { file, line: 1 },
        references: occurrences(source, referenceFiles, [name, `${pascal(family)}V${version}`]),
      });
    }
    out.push(...found.values());
  }
  return out;
}
