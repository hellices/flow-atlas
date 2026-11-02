import { dirname } from "node:path";
import type { Config } from "../config.js";
import type { Component, DeclaredEdge } from "../model.js";
import { select, type Source } from "../source.js";

export function extractComponents(source: Source, config: Config): { components: Component[]; declared: DeclaredEdge[]; limits: string[] } {
  const byName = new Map<string, Component>();
  const limits: string[] = [];
  for (const c of config.components) byName.set(c.name, { name: c.name, path: c.path.replace(/\/+$/, ""), provides: [], consumes: [] });

  if (config.manifest?.kind === "component-json") {
    for (const file of select(source, [config.manifest.glob], [])) {
      const text = source.read(file);
      if (text === undefined) continue;
      try {
        const json = JSON.parse(text) as { name?: string; provides?: string[]; consumes?: string[] };
        if (!json.name) continue;
        const existing = byName.get(json.name);
        byName.set(json.name, {
          name: json.name,
          path: existing?.path ?? dirname(file),
          provides: json.provides ?? [],
          consumes: json.consumes ?? [],
        });
      } catch {
        limits.push(`${file}: not valid JSON, its declarations were skipped`);
      }
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
