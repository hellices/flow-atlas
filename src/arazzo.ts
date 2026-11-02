import type { Config } from "./config.js";
import type { FlowObject, LoadedFile } from "./flows.js";
import type { Graph } from "./model.js";
import { documentPathKeys, operationShape } from "./extract/apidocs.js";

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
const sourceName = (component: string): string => component.replace(/[^A-Za-z0-9_-]/g, "-");

function parseSurfaceId(id: string): { component: string; method: string; path: string } | undefined {
  const m = /^([^|]+)\|([A-Z]+|\*) (\/.*)$/.exec(id);
  return m ? { component: m[1]!, method: m[2]!, path: m[3]! } : undefined;
}

/**
 * The URL of a component's chosen description: a committed file as is, a served path joined to the environment's
 * `origins` entry. A served path without an origin is written as is, with a note: the origin belongs to the
 * environment, not the code. An ambiguous or missing description is an error: export never picks one.
 */
export function documentUrl(component: string, graph: Graph, config: Config): { url: string; note?: string; file?: string } {
  if (config.openapi[component]) {
    const url = config.openapi[component]!;
    return { url, ...(/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/") ? {} : { file: url }) };
  }
  const d = graph.apiDescriptions.find((x) => x.component === component);
  if (!d || d.status !== "chosen" || !d.location) {
    const why = d ? `${d.reason}${d.message ? ` (${d.message})` : ""}` : "NoneFound";
    throw new Error(`no OpenAPI description is decided for ${component}: ${why}; choose one and set openapi.${component}`);
  }
  if (d.kind !== "served") return { url: d.location, file: d.location };
  const origin = config.origins[component];
  if (origin) return { url: `${origin.replace(/\/+$/, "")}${d.location}` };
  const doc = graph.apiDocuments.find((x) => x.component === component && x.location === d.location);
  return {
    url: d.location,
    note: `${component} serves its OpenAPI document at ${d.location}${doc ? ` (${doc.at.file}:${doc.at.line})` : ""}; set origins.${component} to the server's base URL for the environment`,
  };
}

/**
 * `read` gives the text of a repository file, so an operationPath can name the path key a committed description
 * actually uses. Without it, or for a served description, the code's path is written.
 */
export function toArazzo(
  graph: Graph,
  files: LoadedFile[],
  config: Config,
  options: { flow?: string; title: string; read?: (path: string) => string | undefined },
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
  if (available.size === 0) throw new Error("nothing to export: no flow description is active");
  if (options.flow && !available.has(options.flow)) throw new Error(`nothing to export: no active flow is named ${options.flow}`);
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
  const described = new Map<string, { url: string; keys?: Map<string, string>; file?: string } | undefined>();
  const description = (component: string) => {
    if (!described.has(component)) {
      try {
        const { url, note, file } = documentUrl(component, graph, config);
        if (note) limits.push(note);
        const text = file ? options.read?.(file) : undefined;
        const keys = text === undefined ? undefined : documentPathKeys(text);
        described.set(component, { url, ...(keys ? { keys, file } : {}) });
      } catch (e) {
        problems.push((e as Error).message);
        described.set(component, undefined);
      }
    }
    return described.get(component);
  };
  const sourceCount = new Set(
    flows.flatMap((f) => f.spec.steps.map((s) => (s.surface ? parseSurfaceId(s.surface)?.component : s.call ? calls.get(s.call)?.to : undefined))),
  );
  sourceCount.delete(undefined);
  const qualify = sourceCount.size > 1;

  const operation = (surfaceId: string, where: string): Record<string, string> | undefined => {
    const parsed = parseSurfaceId(surfaceId);
    if (!parsed) return undefined;
    if (parsed.method === "*") {
      limits.push(`${where}: ${surfaceId} accepts any method, which an OpenAPI operation cannot name`);
      return undefined;
    }
    const name = sourceName(parsed.component);
    const doc = description(parsed.component);
    const operationId = surfaces.get(surfaceId)?.operationId;
    if (operationId) return { operationId: qualify ? `$sourceDescriptions.${name}.${operationId}` : operationId };
    let key = parsed.path;
    if (doc?.keys) {
      const written = doc.keys.get(operationShape(parsed.method, parsed.path));
      if (!written) {
        limits.push(`${where}: ${doc.file} declares no ${parsed.method} ${parsed.path}`);
        return undefined;
      }
      key = written;
    }
    return { operationPath: `{$sourceDescriptions.${name}.url}#/paths/${pointer(key)}/${parsed.method.toLowerCase()}` };
  };

  const workflows = flows.map((f) => {
    const steps = f.spec.steps.flatMap((s) => {
      const where = `${f.metadata.name}.${s.stepId}`;
      let target: Record<string, string> | undefined;
      if (s.flow) {
        if (names.has(s.flow)) target = { workflowId: s.flow };
        else limits.push(`${where}: flow ${s.flow} is not in this export`);
      } else if (s.surface) {
        target = operation(s.surface, where);
      } else if (s.call) {
        const reached = targets.get(s.call) ?? [];
        if (reached.length === 1) target = operation(reached[0]!, where);
        else limits.push(`${where}: call ${s.call} reaches ${reached.length} surfaces; name the surface instead`);
      }
      if (!target) return [];
      return [
        {
          stepId: s.stepId,
          ...(s.role ? { description: s.role } : {}),
          ...target,
          "x-flow-atlas": { ...(s.surface ? { surface: s.surface } : {}), ...(s.call ? { call: s.call } : {}), ...(s.lifecycle ? { lifecycle: s.lifecycle } : {}) },
        },
      ];
    });
    return {
      workflowId: f.metadata.name,
      ...(f.metadata.title ? { summary: f.metadata.title } : {}),
      ...(f.metadata.description ? { description: f.metadata.description } : {}),
      steps,
      "x-flow-atlas": {
        lifecycle: f.spec.lifecycle ?? "active",
        ...(f.spec.owner ? { owner: f.spec.owner } : {}),
        ...(f.spec.entry ? { entry: f.spec.entry } : {}),
        ...(f.metadata.labels ? { labels: f.metadata.labels } : {}),
        ...(f.spec.produces ? { produces: f.spec.produces } : {}),
      },
    };
  });
  for (const w of workflows) if (w.steps.length === 0) limits.push(`${w.workflowId}: no step could be written as an operation`);

  if (problems.length) throw new Error(problems.join("\n"));
  const exported = workflows.filter((w) => w.steps.length > 0);
  const sourceDescriptions = [...described]
    .filter(([, d]) => d)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([component, d]) => ({ name: sourceName(component), url: d!.url, type: "openapi" }));
  // Arazzo requires at least one workflow and one source description.
  if (exported.length === 0 || sourceDescriptions.length === 0)
    throw new Error(`nothing to export: no step of the selected flows could be written as an operation${limits.length ? `\n${limits.join("\n")}` : ""}`);
  const commit = graph.provenance.resolvedDependencies.find((d) => d.name === "code")?.digest?.gitCommit;
  return {
    document: {
      arazzo: "1.0.1",
      info: {
        title: options.title,
        version: commit ? `0.0.0+${commit.slice(0, 12)}` : "0.0.0+worktree",
        description: "Generated by flow-atlas from the repository's Flow descriptions and code. Parameters, request bodies and success criteria are left for the workflow's runner.",
      },
      sourceDescriptions,
      workflows: exported,
      "x-flow-atlas-provenance": graph.provenance,
    },
    limits,
  };
}
