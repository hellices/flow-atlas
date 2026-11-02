import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
import type { Config } from "./config.js";
import type { Provenance, ResourceDescriptor } from "./model.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export const VERSION = pkg.version;

export function provenance(kind: string, externalParameters: Record<string, string>, resolvedDependencies: ResourceDescriptor[]): Provenance {
  return {
    builder: { id: "flow-atlas", version: VERSION },
    buildType: `flow-atlas/${kind}@v1alpha1`,
    externalParameters,
    resolvedDependencies,
  };
}

/** The same inputs, for a document derived from another (a trace from a graph), with any inputs it adds. */
export function derived(from: Provenance, kind: string, externalParameters: Record<string, string>, more: ResourceDescriptor[] = []): Provenance {
  return provenance(kind, { ...from.externalParameters, ...externalParameters }, [...from.resolvedDependencies, ...more]);
}

/** The repository read at a commit, or its working tree, which has no digest. */
export function codeDependency(name: string, commit: string): ResourceDescriptor {
  return commit === "WORKTREE" ? { name, uri: "." } : { name, uri: ".", digest: { gitCommit: commit } };
}

/** The configuration file, named relative to the repository when it lies inside it, otherwise by its file name. */
export function configDependency(config: Config, root: string | undefined): ResourceDescriptor[] {
  if (!config.file) return [];
  const rel = root ? relative(root, config.file.path) : "";
  const uri = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : basename(config.file.path);
  return [{ name: "config", uri, digest: { sha256: config.file.sha256 } }];
}

export function fileDependency(name: string, uri: string, text: string): ResourceDescriptor {
  return { name, uri, digest: { sha256: createHash("sha256").update(text).digest("hex") } };
}
