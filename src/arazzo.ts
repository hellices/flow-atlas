import { chainRoot } from "./chains.js";
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

/** Whether a path names a regular file on this machine; a directory or anything unreadable does not. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
import type { Config } from "./config.js";
import type { FlowObject, LoadedFile } from "./flows.js";
import type { Graph } from "./model.js";
import { documentOperationIds, documentPathKeys, operationShape } from "./extract/apidocs.js";

/**
 * Flows as an Arazzo 1.0 description, for API workflow tools such as test runners. A surface becomes an OpenAPI
 * operation: by operationId when the code names one, otherwise by operationPath into the component's OpenAPI
 * description. A call step becomes the operation it reaches, a sub-flow step a workflowId. What Arazzo needs to run a
 * step (parameters, request bodies, success criteria) is not in the code and is left for whoever runs the workflow.
 */
export interface ArazzoExport {
  document: Record<string, unknown>;
  /** Steps that could not be written as an operation, and why. */
  limits: string[];
}

const pointer = (path: string): string => path.replace(/~/g, "~0").replace(/\//g, "~1");
/**
 * Arazzo source description names (letters, digits, _ and -) for every component, unique even where two component
 * names reduce to the same characters: in name order, a later one gets `-2`, `-3`. Assigned over all components, so a
 * component keeps its name whichever flows are exported.
 */
export function sourceNames(components: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const component of [...new Set(components)].sort()) {
    const base = component.replace(/[^A-Za-z0-9_-]/g, "-");
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    out.set(component, name);
  }
  return out;
}

function parseSurfaceId(id: string): { component: string; method: string; path: string } | undefined {
  const m = /^([^|]+)\|([A-Z]+|\*) (\/.*)$/.exec(id);
  return m ? { component: m[1]!, method: m[2]!, path: m[3]! } : undefined;
}

/**
 * Where a path leads on this disk, links followed as far as anything exists: the nearest existing ancestor's real
 * path with the rest appended, and a dangling link's target in its place. Undefined for links that cannot be followed
 * to an end.
 */
function settle(path: string, hops = 0): string | undefined {
  const rest: string[] = [];
  for (let head = resolve(path); ; head = dirname(head)) {
    let link: boolean;
    try {
      link = lstatSync(head).isSymbolicLink();
    } catch {
      if (dirname(head) === head) return resolve(path);
      rest.unshift(basename(head));
      continue;
    }
    if (!link || existsSync(head)) {
      try {
        return join(realpathSync(head), ...rest);
      } catch {
        return undefined;
      }
    }
    if (hops >= 32) return undefined;
    return settle(join(resolve(realpathSync(dirname(head)), readlinkSync(head)), ...rest), hops + 1);
  }
}

const real = (path: string): string => settle(path) ?? resolve(path);

const within = (base: string, file: string): string | undefined => {
  const rel = relative(base, file);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel.split(sep).join("/") : undefined;
};

/**
 * A file's path in the repository, relative to its root and `/`-separated, or undefined for a file outside it. Without
 * the root, an absolute path is taken as outside, as route extraction takes it.
 *
 * A file on this disk is where its links lead. A committed link to a file outside the repository is outside: git keeps
 * only the link's text, so on any other machine, and at any revision read from git, it names nothing. A file not on
 * this disk (one that exists only at another revision) is placed where the links on its path lead: a link whose
 * target does not exist yet stands for that target, as a link to a generated file does before it is generated. Only a
 * link that cannot be followed to an end (a loop, or more than 32 hops) leaves the file out of the repository.
 */
export function repositoryPath(path: string, root: string | undefined): string | undefined {
  if (!root) {
    if (isAbsolute(path)) return undefined;
    const normal = posix.normalize(path.split(sep).join("/"));
    return normal === ".." || normal.startsWith("../") ? undefined : normal;
  }
  const at = settle(resolve(root, path));
  // The root itself may be reached through a link (a temporary directory, a checkout under a linked home).
  return at === undefined ? undefined : within(real(root), at);
}

/** The one path a component's code serves its OpenAPI document at; a page that shows another served path is that path. */
function servedPath(component: string, graph: Graph): string | undefined {
  const docs = graph.apiDocuments.filter((d) => d.component === component && d.kind === "served");
  const paths = new Set(docs.map((d) => d.location));
  const own = new Set(docs.filter((d) => !(d.aliasOf && d.aliasOf !== d.location && paths.has(d.aliasOf))).map((d) => d.location));
  return own.size === 1 ? [...own][0] : undefined;
}

export interface DocumentUrl {
  url: string;
  note?: string;
  /** The file to read the description from: in the repository, relative to its root; outside it, where it is on this machine. */
  file?: string;
}

/**
 * The URL of a component's chosen description. A file in the repository is written relative to its root, where the
 * exported document is assumed to be kept. A file outside it is not written as a path on this machine but by its file
 * name, with a note to commit or publish it: nothing in the code says it is the document the component serves, so a
 * served path is not put in for it. A served path is joined to the environment's `origins` entry; without
 * one it is written as is, with a note: the origin belongs to the environment, not the code. A missing description is
 * returned as `missing`, so the steps it would serve are left out; an ambiguous one is an error: export never picks one.
 */
export function documentUrl(component: string, graph: Graph, config: Config, root?: string): DocumentUrl | { missing: string; url?: never; note?: never; file?: never } {
  const origin = config.origins[component]?.replace(/\/+$/, "");
  const file = (path: string): DocumentUrl => {
    const inside = repositoryPath(path, root);
    if (inside !== undefined) return { url: inside.split("/").map(encodeURIComponent).join("/"), file: inside };
    const given = root ? resolve(root, path) : path;
    const at = root ? real(given) : path;
    const name = basename(at);
    const served = servedPath(component, graph);
    const instead = served
      ? `; if it is the document ${component} serves at ${served}, set openapi.${component} to ${served} and origins.${component} to the server's base URL instead`
      : "";
    return {
      url: encodeURIComponent(name),
      file: at,
      note: `${component}'s OpenAPI document ${path}${at !== given ? ` (${at})` : ""} is outside the repository; written as ${name}, a file next to this document: commit the document to the repository, or publish it and set openapi.${component} to its URL${instead}`,
    };
  };
  if (config.openapi[component]) {
    const url = config.openapi[component];
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return { url };
    // A root-relative choice is a served path, unless it names a file in the repository (at any revision) or on this
    // machine: the environment's origin goes in front of a served path, as for a found one.
    if (url.startsWith("/") && repositoryPath(url, root) === undefined && !isFile(url)) {
      return origin
        ? { url: `${origin}${url}` }
        : { url, note: `${component}'s chosen OpenAPI document ${url} is served; set origins.${component} to the server's base URL for the environment` };
    }
    return file(url);
  }
  const d = graph.apiDescriptions.find((x) => x.component === component);
  if (!d || d.status !== "chosen" || !d.location) {
    const why = d ? `${d.reason}${d.message ? ` (${d.message})` : ""}` : "NoneFound";
    const missing = `no OpenAPI description is decided for ${component}: ${why}`;
    if (d?.status === "ambiguous") throw new Error(`${missing}; choose one and set openapi.${component}`);
    return { missing };
  }
  if (d.kind !== "served") return file(d.location);
  if (origin) return { url: `${origin}${d.location}` };
  const doc = graph.apiDocuments.find((x) => x.component === component && x.location === d.location);
  return {
    url: d.location,
    note: `${component} serves its OpenAPI document at ${d.location}${doc ? ` (${doc.at.file}:${doc.at.line})` : ""}; set origins.${component} to the server's base URL for the environment`,
  };
}

/** The flows selected hold nothing an Arazzo description can carry; `export arazzo` exits 1 for it, not 2. */
export class NothingToExport extends Error {}

/**
 * `read` gives the text of a repository file, so an operationPath can name the path key a committed description
 * actually uses. Without it, or for a served description, the code's path is written. `root`, the repository's
 * directory, tells a file in the repository given by absolute path from one outside it.
 *
 * A step that cannot be written is left out and its workflow is written without it, saying so in the workflow's
 * description and `x-flow-atlas.omitted`; a workflow none of whose steps can be written is left out.
 */
export function toArazzo(
  graph: Graph,
  files: LoadedFile[],
  config: Config,
  options: { flow?: string; title: string; root?: string; read?: (path: string) => string | undefined },
): ArazzoExport {
  const limits: string[] = [];
  const surfaces = new Map(graph.surfaces.map((s) => [s.id, s]));
  const calls = new Map(graph.calls.map((c) => [c.id, c]));
  const targets = new Map<string, string[]>();
  for (const e of graph.edges) if (e.kind === "match") (targets.get(e.from) ?? targets.set(e.from, []).get(e.from)!).push(e.to);

  const available = new Map<string, FlowObject>();
  for (const f of files.flatMap((x) => x.flows.map((y) => y.object))) {
    if ((f.spec.lifecycle ?? "active") !== "deprecated" && !available.has(f.metadata.name)) available.set(f.metadata.name, f);
  }
  // A flow the export would need may be in a file that cannot be read: that is an input error, not an empty export.
  if (available.size === 0 || (options.flow && !available.has(options.flow))) {
    const unread = files.filter((f) => f.errors.length);
    if (unread.length) throw new Error(`flow files cannot be read:\n${unread.map((f) => `${f.file}: ${f.errors.join("; ")}`).join("\n")}`);
  }
  if (available.size === 0) throw new NothingToExport("nothing to export: no flow description is active");
  if (options.flow && !available.has(options.flow)) throw new NothingToExport(`nothing to export: no active flow is named ${options.flow}`);
  // A selected flow brings the flows its steps run, so each workflowId it names is in the export.
  const selected = new Set<string>();
  const queue = options.flow ? [options.flow] : [...available.keys()];
  while (queue.length) {
    const name = queue.shift()!;
    if (selected.has(name)) continue;
    selected.add(name);
    for (const s of available.get(name)!.spec.steps) if (s.flow && available.has(s.flow)) queue.push(s.flow);
  }
  const flows = [...available.values()].filter((f) => selected.has(f.metadata.name));
  const names = new Set(flows.map((f) => f.metadata.name));

  const problems: string[] = [];
  type Described = { url: string; note?: string; file?: string; keys?: Map<string, string>; ids?: Map<string, string> };
  const described = new Map<string, Described | { missing: string }>();
  const description = (component: string) => {
    if (!described.has(component)) {
      try {
        const found = documentUrl(component, graph, config, options.root);
        if ("missing" in found) described.set(component, { missing: found.missing });
        else {
          const text = found.file ? options.read?.(found.file) : undefined;
          const keys = text === undefined ? undefined : documentPathKeys(text);
          const ids = text === undefined ? undefined : documentOperationIds(text);
          described.set(component, { ...found, ...(keys ? { keys, ids } : {}) });
        }
      } catch (e) {
        problems.push((e as Error).message);
        described.set(component, { missing: (e as Error).message });
      }
    }
    return described.get(component)!;
  };
  // A file outside the repository is where documentUrl reads it: resolved against the root, links followed.
  const located = (path: string) => repositoryPath(path, options.root) ?? (options.root ? real(resolve(options.root, path)) : path);
  const sameFile = (a: string, b: string) => located(a) === located(b);
  const sourceNameOf = sourceNames([
    ...graph.components.map((c) => c.name),
    ...graph.surfaces.map((x) => x.component),
    ...flows.flatMap((f) => f.spec.steps.map((s) => (s.surface ? parseSurfaceId(s.surface)?.component : s.chain ? parseSurfaceId(chainRoot(s.chain) ?? "")?.component : undefined)).filter((c): c is string => !!c)),
  ]);
  const sourceName = (component: string): string => sourceNameOf.get(component)!;
  const sourceCount = new Set(
    flows.flatMap((f) => f.spec.steps.map((s) => (s.surface ? parseSurfaceId(s.surface)?.component : s.call ? calls.get(s.call)?.to : s.chain ? parseSurfaceId(chainRoot(s.chain) ?? "")?.component : undefined))),
  );
  sourceCount.delete(undefined);
  const qualify = sourceCount.size > 1;

  /** Why a step is left out: `reason` goes into the exported document, `limit` (when it differs) to the author. */
  type Left = { reason: string; limit?: string };
  const operation = (surfaceId: string): Record<string, string> | Left => {
    const parsed = parseSurfaceId(surfaceId);
    if (!parsed) return { reason: `${surfaceId} is not a surface id` };
    if (parsed.method === "*") return { reason: `${surfaceId} accepts any method, which an OpenAPI operation cannot name` };
    const name = sourceName(parsed.component);
    const doc = description(parsed.component);
    if ("missing" in doc)
      return {
        reason: doc.missing,
        limit: `${doc.missing}; set openapi.${parsed.component} to its OpenAPI document, or routes[].openapi to the one its framework generates`,
      };
    const surface = surfaces.get(surfaceId);
    const byId = (id: string) => ({ operationId: qualify ? `$sourceDescriptions.${name}.${id}` : id });
    const byPath = (key: string) => ({ operationPath: `{$sourceDescriptions.${name}.url}#/paths/${pointer(key)}/${parsed.method.toLowerCase()}` });
    // A description atlas can read decides the operation: its own operationId, else the key it writes the path under.
    if (doc.keys) {
      const shape = operationShape(parsed.method, parsed.path);
      const written = doc.keys.get(shape);
      // The exported document does not name a file on this machine; the author's limit does.
      if (!written)
        return { reason: `the OpenAPI description of ${parsed.component} declares no ${parsed.method} ${parsed.path}`, limit: `${doc.file} declares no ${parsed.method} ${parsed.path}` };
      const id = doc.ids?.get(shape);
      return id ? byId(id) : byPath(written);
    }
    if (surface?.operationId) return byId(surface.operationId);
    // A surface read from the chosen document carries the key that document writes it under.
    return byPath(surface?.describedPath && doc.file && surface.described && sameFile(surface.described.file, doc.file) ? surface.describedPath : parsed.path);
  };

  type Omitted = { at: number; stepId: string; reason: string };
  const workflows = flows.map((f) => {
    const omitted: Omitted[] = [];
    const steps = f.spec.steps.flatMap((s, at) => {
      const where = `${f.metadata.name}.${s.stepId}`;
      let target: Record<string, string> | Left | undefined;
      if (s.flow) target = names.has(s.flow) ? { workflowId: s.flow } : { reason: `flow ${s.flow} is not in this export` };
      else if (s.surface) target = operation(s.surface);
      else if (s.chain) {
        // A chain step is its request: the operation of the surface that serves it.
        const root = chainRoot(s.chain);
        target = root ? operation(root) : { reason: `${s.chain} is not a chain id` };
      } else if (s.call) {
        const reached = targets.get(s.call) ?? [];
        target = reached.length === 1 ? operation(reached[0]!) : { reason: `call ${s.call} reaches ${reached.length} surfaces; name the surface instead` };
      }
      if (!target) return [];
      if ("reason" in target) {
        limits.push(`${where}: ${target.limit ?? target.reason}`);
        omitted.push({ at, stepId: s.stepId, reason: target.reason });
        return [];
      }
      return [
        {
          stepId: s.stepId,
          ...(s.role ? { description: s.role } : {}),
          ...target,
          "x-flow-atlas": {
            ...(s.surface ? { surface: s.surface } : {}),
            ...(s.call ? { call: s.call } : {}),
            ...(s.chain ? { chain: s.chain } : {}),
            ...(s.lifecycle ? { lifecycle: s.lifecycle } : {}),
          },
        },
      ];
    });
    return { flow: f, steps, omitted };
  });
  if (problems.length) throw new Error(problems.join("\n"));
  // A workflow with no step is left out, and so is every step that runs it, until nothing changes.
  let exported = workflows;
  for (;;) {
    const empty = new Set(exported.filter((w) => w.steps.length === 0).map((w) => w.flow.metadata.name));
    if (empty.size === 0) break;
    for (const id of empty) limits.push(`${id}: no step could be written as an operation`);
    exported = exported
      .filter((w) => !empty.has(w.flow.metadata.name))
      .map((w) => {
        const omitted = [...w.omitted];
        const steps = w.steps.filter((s) => {
          const runs = (s as { workflowId?: string }).workflowId;
          if (!(runs && empty.has(runs))) return true;
          const reason = `flow ${runs} is not in this export`;
          limits.push(`${w.flow.metadata.name}.${s.stepId}: ${reason}`);
          omitted.push({ at: w.flow.spec.steps.findIndex((x) => x.stepId === s.stepId), stepId: s.stepId, reason });
          return false;
        });
        return { ...w, steps, omitted };
      });
  }
  const written = [...described].filter((e): e is [string, Described] => !("missing" in e[1])).sort(([a], [b]) => a.localeCompare(b));
  for (const [, d] of written) if (d.note) limits.push(d.note);
  // A document outside the repository is written by its file name, which another document's URL may already be.
  const byUrl = new Map<string, Array<[string, string]>>();
  for (const [component, d] of written) if (d.file) byUrl.set(d.url, [...(byUrl.get(d.url) ?? []), [component, d.file]]);
  for (const [url, uses] of byUrl)
    if (new Set(uses.map(([, file]) => file)).size > 1)
      limits.push(`${uses.map(([c]) => c).join(" and ")} are written as ${decodeURIComponent(url)} from different documents; rename the documents outside the repository, commit them or publish them`);
  const sourceDescriptions = written.map(([component, d]) => ({ name: sourceName(component), url: d.url, type: "openapi" }));
  // Arazzo requires at least one workflow and one source description.
  if (exported.length === 0 || sourceDescriptions.length === 0)
    throw new NothingToExport(`nothing to export: no step of the selected flows could be written as an operation${limits.length ? `\n${limits.join("\n")}` : ""}`);
  const relativeFiles = written.some(([, d]) => d.file && !/^[a-z][a-z0-9+.-]*:/i.test(d.url));
  const commit = graph.provenance.resolvedDependencies.find((d) => d.name === "code")?.digest?.gitCommit;
  return {
    document: {
      arazzo: "1.0.1",
      info: {
        title: options.title,
        version: commit ? `0.0.0+${commit.slice(0, 12)}` : "0.0.0+worktree",
        description: `Generated by flow-atlas from the repository's Flow descriptions and code. Parameters, request bodies and success criteria are left for the workflow's runner.${
          relativeFiles ? " Relative source description URLs are resolved against this document, which is assumed to sit at the repository root." : ""
        }`,
      },
      sourceDescriptions,
      workflows: exported.map(({ flow: f, steps, omitted }) => {
        const left = omitted.sort((a, b) => a.at - b.at).map(({ stepId, reason }) => ({ stepId, reason }));
        // A workflow is a sequence: one written without some of its steps says so where a viewer shows it.
        const note = left.length ? `Left out of this export, so these steps are not the whole flow: ${left.map((l) => `${l.stepId} (${l.reason})`).join("; ")}.` : undefined;
        const description = [f.metadata.description, note].filter(Boolean).join("\n\n");
        return {
          workflowId: f.metadata.name,
          ...(f.metadata.title ? { summary: f.metadata.title } : {}),
          ...(description ? { description } : {}),
          steps,
          "x-flow-atlas": {
            lifecycle: f.spec.lifecycle ?? "active",
            ...(f.spec.owner ? { owner: f.spec.owner } : {}),
            ...(f.spec.entry ? { entry: f.spec.entry } : {}),
            ...(f.metadata.labels ? { labels: f.metadata.labels } : {}),
            ...(f.spec.produces ? { produces: f.spec.produces } : {}),
            ...(left.length ? { omitted: left } : {}),
          },
        };
      }),
      "x-flow-atlas-provenance": graph.provenance,
    },
    limits,
  };
}
