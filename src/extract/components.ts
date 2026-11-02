import { dirname } from "node:path";
import type { Config } from "../config.js";
import type { Component, DeclaredEdge } from "../model.js";
import { select, type Source } from "../source.js";

export function extractComponents(source: Source, config: Config): { components: Component[]; declared: DeclaredEdge[]; limits: string[] } {
  const byName = new Map<string, Component>();
  const limits: string[] = [];
  for (const c of config.components) byName.set(c.name, { name: c.name, path: c.path.replace(/\/+$/, ""), provides: [], consumes: [] });

  if (config.manifest?.kind === "component-json") {
    for (const file of select(source, [config.manifest.glob], config.exclude)) {
      const text = source.read(file);
      if (text === undefined) continue;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        limits.push(`${file}: not valid JSON, its declarations were skipped`);
        continue;
      }
      const m = json as { name?: unknown; provides?: unknown; consumes?: unknown } | null;
      if (!m || typeof m !== "object" || Array.isArray(m) || m.name === undefined) continue;
      const strings = (v: unknown): v is string[] => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
      if (typeof m.name !== "string" || !m.name || !strings(m.provides) || !strings(m.consumes)) {
        limits.push(`${file}: name must be a string and provides and consumes lists of strings; its declarations were skipped`);
        continue;
      }
      const existing = byName.get(m.name);
      byName.set(m.name, {
        name: m.name,
        path: existing?.path ?? dirname(file),
        provides: (m.provides as string[] | undefined) ?? [],
        consumes: (m.consumes as string[] | undefined) ?? [],
      });
    }
  }

  const components = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const provider = new Map<string, string>();
  for (const c of components) for (const api of c.provides) provider.set(api, c.name);
  const declared: DeclaredEdge[] = [];
  for (const c of components) {
    for (const api of c.consumes) {
      const to = provider.get(api);
      if (to && to !== c.name) declared.push({ from: c.name, to, via: api });
      else if (!to) limits.push(`${c.name} consumes ${api}, which no component provides`);
    }
  }
  return { components, declared, limits };
}
