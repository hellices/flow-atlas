import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { LineCounter, parseAllDocuments } from "yaml";
import { deriveChains, type Chain, type ChainReport } from "./chains.js";
import type { Config } from "./config.js";
import { FlowIndex } from "./flow.js";
import { API_VERSION, type Document, type Edge, type Finding, type Graph, type Place, type ResourceDescriptor } from "./model.js";
import { derived, fileDependency } from "./provenance.js";
import { validate } from "./schema.js";
import { select, type Source } from "./source.js";

/** A flow as written, one per YAML document; see schema/flow.schema.json. Envelope after the Kubernetes Resource Model, steps after Arazzo. */
export interface FlowObject {
  apiVersion: typeof API_VERSION;
  kind: "Flow";
  metadata: {
    name: string;
    title?: string;
    description?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    /** The decisions, designs or issues behind the flow. */
    sources?: Array<{ id?: string; resource: string; title?: string; author?: string; last_modified?: string }>;
  };
  spec: {
    lifecycle?: Lifecycle;
    owner?: string;
    entry?: { component: string; description?: string };
    produces?: string[];
    steps: StepSpec[];
  };
}

export type Lifecycle = "active" | "planned" | "deprecated";

export interface StepSpec {
  stepId: string;
  surface?: string;
  call?: string;
  /** A chain atlas derives (`atlas chains`): one request and every surface it reaches. */
  chain?: string;
  flow?: string;
  role?: string;
  lifecycle?: "active" | "planned";
}

export interface LoadedFile {
  file: string;
  text: string;
  flows: Array<{ object: FlowObject; line: number; stepLine: (i: number) => number }>;
  errors: string[];
}

export type ConditionType = "Ready" | "Resolved" | "Connected" | "ProducesListed" | "Documented";

/** After Kubernetes conditions, without transition times: the same inputs give the same document. */
export interface Condition {
  type: ConditionType;
  status: "True" | "False" | "Unknown";
  /** A stable CamelCase code a tool can branch on. */
  reason: string;
  message?: string;
}

export interface StepStatus {
  stepId: string;
  line: number;
  kind: "surface" | "call" | "chain" | "flow";
  target: string;
  lifecycle: "active" | "planned";
  resolved: boolean;
  at?: Place;
  /**
   * The shortest chain of edges to the next step; absent on the last step or when either side is unresolved. `order:
   * declared` when both steps are requests and the code does not show that the first leads to the second: the order is
   * the author's, neither confirmed nor contradicted.
   */
  toNext?: { connected: boolean; edges: Edge[]; order?: "declared" };
}

export interface FlowStatus {
  /** The commit the flow was held against, or WORKTREE. */
  observedRef: string;
  lifecycle: Lifecycle;
  conditions: Condition[];
  entry?: { component: string; callers: string[] };
  steps: StepStatus[];
  produces: Array<{ id: string; found: boolean }>;
}

export interface FlowReport extends Document<"FlowReport"> {
  files: Array<{ file: string; flows: string[]; errors: string[] }>;
  items: Array<{ apiVersion: typeof API_VERSION; kind: "Flow"; metadata: FlowObject["metadata"]; status: FlowStatus }>;
  /** Surfaces that no active or planned flow names as a step or passes through. */
  unassigned: string[];
}

export const LOCATION = "flow-atlas.dev/location";

function parse(file: string, text: string): LoadedFile {
  const counter = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: counter });
  const loaded: LoadedFile = { file, text, flows: [], errors: [] };
  if (!Array.isArray(docs)) {
    loaded.errors.push("not a YAML stream");
    return loaded;
  }
  docs.forEach((doc, di) => {
    const where = docs.length > 1 ? `document ${di + 1}: ` : "";
    if (doc.errors.length) {
      loaded.errors.push(...doc.errors.map((e) => `${where}${e.message}`));
      return;
    }
    const value: unknown = doc.toJS();
    if (value === null || value === undefined) return;
    const errors = validate("flow", value);
    if (errors.length) {
      loaded.errors.push(...errors.map((e) => `${where}${e}`));
      return;
    }
    const line = (path: Array<string | number>): number => {
      const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
      return node?.range ? counter.linePos(node.range[0]).line : 1;
    };
    loaded.flows.push({ object: value as FlowObject, line: line(["metadata", "name"]), stepLine: (i) => line(["spec", "steps", i]) });
  });
  return loaded;
}

function walkDir(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkDir(p));
    else if (name.endsWith(".flow.yaml") || name.endsWith(".flow.yml")) out.push(p);
  }
  return out.sort();
}

/**
 * Flow files from the repository (the configured globs, read at the same revision as the code) and, for a repository
 * atlas must not write to, from `<out>/flows`.
 */
export function loadFlows(source: Source, config: Config, outDir?: string): LoadedFile[] {
  const out: LoadedFile[] = [];
  for (const file of select(source, config.flows, [])) {
    const text = source.read(file);
    if (text !== undefined) out.push(parse(file, text));
  }
  const extra = outDir ? join(outDir, "flows") : undefined;
  if (extra && existsSync(extra)) {
    for (const p of walkDir(extra)) out.push(parse(relative(outDir!, p), readFileSync(p, "utf8")));
  }
  return out;
}

const MAX_HOPS = 8;

const condition = (type: ConditionType, status: Condition["status"], reason: string, message?: string): Condition => ({
  type,
  status,
  reason,
  ...(message ? { message } : {}),
});

/**
 * `asOf` is when the code read was current (the commit's time for a commit), recorded in the provenance.
 * `chains` are the ones atlas derives from the same graph; chain steps name them.
 */
export function resolveFlows(graph: Graph, files: LoadedFile[], asOf: string, chains: ChainReport = deriveChains(graph, { publicSurfaces: [] })): FlowReport {
  const index = new FlowIndex(graph);
  const chainById = new Map<string, Chain>(chains.chains.map((c) => [c.id, c]));
  const registries = new Set(graph.registries.map((r) => r.id));
  const byName = new Map<string, FlowObject>();
  for (const f of files) for (const { object } of f.flows) if (!byName.has(object.metadata.name)) byName.set(object.metadata.name, object);
  const commit = graph.provenance.resolvedDependencies.find((d) => d.name === "code")?.digest?.gitCommit ?? "WORKTREE";

  /** The node a step stands for when entering it (first) or leaving it (last); a sub-flow stands for its ends. */
  const node = (step: StepSpec, end: "first" | "last", depth = 0): string | undefined => {
    if (step.surface) return index.surfaces.has(step.surface) ? step.surface : undefined;
    if (step.call) return index.calls.has(step.call) ? step.call : undefined;
    if (step.chain) return chainById.get(step.chain)?.root;
    const sub = step.flow ? byName.get(step.flow) : undefined;
    if (!sub || depth > 4) return undefined;
    const steps = sub.spec.steps;
    const s = end === "first" ? steps[0] : steps[steps.length - 1];
    return s ? node(s, end, depth + 1) : undefined;
  };

  /** The chain a step enters by (first) or leaves by (last), looking through sub-flows to their end steps. */
  const boundaryChain = (step: StepSpec, end: "first" | "last", depth = 0): Chain | undefined => {
    if (step.chain) return chainById.get(step.chain);
    const sub = step.flow ? byName.get(step.flow) : undefined;
    if (!sub || depth > 4) return undefined;
    const steps = sub.spec.steps;
    const s = end === "first" ? steps[0] : steps[steps.length - 1];
    return s ? boundaryChain(s, end, depth + 1) : undefined;
  };

  const items: FlowReport["items"] = [];
  const covered = new Set<string>();
  for (const f of files) {
    for (const { object, line, stepLine } of f.flows) {
      const { spec } = object;
      const lifecycle = spec.lifecycle ?? "active";
      const steps: StepStatus[] = spec.steps.map((s, i) => {
        const kind = s.surface ? "surface" : s.call ? "call" : s.chain ? "chain" : "flow";
        const target = (s.surface ?? s.call ?? s.chain ?? s.flow)!;
        const root = s.chain ? chainById.get(s.chain)?.root : undefined;
        const at = s.surface ? index.surfaces.get(s.surface)?.at : s.call ? index.calls.get(s.call)?.at : root ? index.surfaces.get(root)?.at : undefined;
        return {
          stepId: s.stepId,
          line: stepLine(i),
          kind,
          target,
          lifecycle: lifecycle === "planned" ? "planned" : (s.lifecycle ?? "active"),
          resolved: kind === "flow" ? byName.has(target) : kind === "chain" ? chainById.has(target) : node(s, "first") !== undefined,
          ...(at ? { at } : {}),
        };
      });
      for (let i = 0; i + 1 < spec.steps.length; i++) {
        const a = boundaryChain(spec.steps[i]!, "last");
        const b = boundaryChain(spec.steps[i + 1]!, "first");
        if (a && b) {
          // Between two requests, only what the first returns can lead to the second: a page that offers it. Without
          // one, the code neither shows nor contradicts the order, whoever makes the requests.
          const offer = a.next.find((n) => n.chain === b.id);
          const edges = offer ? index.path(offer.from, b.root, 2) : undefined;
          steps[i]!.toNext = edges ? { connected: true, edges } : { connected: false, edges: [], order: "declared" };
          continue;
        }
        const from = node(spec.steps[i]!, "last");
        const to = node(spec.steps[i + 1]!, "first");
        if (!from || !to) continue;
        const edges = index.path(from, to, MAX_HOPS);
        steps[i]!.toNext = { connected: edges !== undefined, edges: edges ?? [] };
      }
      const first = spec.steps[0] ? node(spec.steps[0], "first") : undefined;
      const firstChain = spec.steps[0] ? boundaryChain(spec.steps[0], "first") : undefined;
      // A chain knows who makes its request; a flow that starts with one takes its entry from the code.
      const outside = firstChain?.entry.component === "outside" && !spec.entry;
      const entry = firstChain
        ? outside
          ? undefined
          : {
              component: spec.entry?.component ?? firstChain.entry.component,
              callers: (spec.entry?.component ?? firstChain.entry.component) === firstChain.entry.component ? firstChain.entry.callers : [],
            }
        : spec.entry
        ? {
            component: spec.entry.component,
            callers: !first
              ? []
              : index.calls.has(first)
                ? index.calls.get(first)!.from === spec.entry.component
                  ? [first]
                  : []
                : (index.in.get(first) ?? []).filter((e) => e.kind === "match" && index.calls.get(e.from)?.from === spec.entry!.component).map((e) => e.from),
          }
        : undefined;
      const produces = (spec.produces ?? []).map((id) => ({ id, found: registries.has(id) }));
      const conditions = lifecycle === "deprecated" ? deprecatedConditions() : conditionsFor(steps, produces, object);
      if (lifecycle !== "deprecated") {
        for (const s of steps) if (s.kind === "surface" && s.resolved) covered.add(s.target);
        for (const s of steps) if (s.kind === "chain") for (const id of chainById.get(s.target)?.surfaces ?? []) covered.add(id);
        // A call step passes through the surface it reaches, also when it is the last step.
        for (const s of steps) {
          if (s.kind !== "call" || !s.resolved) continue;
          for (const e of index.out.get(s.target) ?? []) if (e.kind === "match" && index.surfaces.has(e.to)) covered.add(e.to);
        }
        for (const s of steps) for (const e of s.toNext?.edges ?? []) for (const id of [e.from, e.to]) if (index.surfaces.has(id)) covered.add(id);
      }
      items.push({
        apiVersion: API_VERSION,
        kind: "Flow",
        metadata: { ...object.metadata, annotations: { ...object.metadata.annotations, [LOCATION]: `${f.file}:${line}` } },
        status: {
          observedRef: commit,
          lifecycle,
          conditions,
          ...(entry ? { entry } : {}),
          steps,
          produces,
        },
      });
    }
  }
  const inputs: ResourceDescriptor[] = files.map((f) => fileDependency("flows", f.file, f.text));
  return {
    apiVersion: API_VERSION,
    kind: "FlowReport",
    provenance: derived(graph.provenance, "FlowReport", { asOf }, inputs),
    files: files.map((f) => ({ file: f.file, flows: f.flows.map((x) => x.object.metadata.name), errors: f.errors })),
    items,
    unassigned: graph.surfaces.filter((s) => !s.implicit && !covered.has(s.id)).map((s) => s.id),
  };
}

function deprecatedConditions(): Condition[] {
  return (["Ready", "Resolved", "Connected", "ProducesListed", "Documented"] as const).map((t) =>
    condition(t, "Unknown", "Deprecated"),
  );
}

function conditionsFor(steps: StepStatus[], produces: FlowStatus["produces"], object: FlowObject): Condition[] {
  const unresolved = steps.filter((s) => !s.resolved);
  const missing = unresolved.filter((s) => s.lifecycle === "active");
  const resolved =
    unresolved.length === 0
      ? condition("Resolved", "True", "AllStepsResolved")
      : missing.length === 0
        ? condition("Resolved", "True", "PlannedStepsPending", `planned: ${unresolved.map((s) => s.stepId).join(", ")}`)
        : condition("Resolved", "False", "StepNotFound", `not in the code: ${missing.map((s) => `${s.stepId} (${s.target})`).join(", ")}`);

  const pairs = steps.slice(0, -1);
  const gaps = pairs.filter((s) => s.toNext && !s.toNext.connected && s.toNext.order !== "declared");
  const declared = pairs.filter((s) => s.toNext?.order === "declared");
  // A gap next to a planned step is the plan, not yet built; only a gap between two active steps is a fault.
  const broken = gaps.filter((s) => !touchesPlanned(steps, s));
  const planned = gaps.filter((s) => touchesPlanned(steps, s));
  const open = pairs.filter((s) => !s.toNext);
  const pairName = (s: StepStatus) => `${s.stepId} -> ${steps[steps.indexOf(s) + 1]!.stepId}`;
  const connected =
    broken.length > 0
      ? condition("Connected", "False", "NoPathBetweenSteps", broken.map(pairName).join(", "))
      : open.length > 0
        ? condition("Connected", "Unknown", "StepsUnresolved", `not checked: ${open.map((s) => s.stepId).join(", ")}`)
        : planned.length > 0
          ? condition("Connected", "Unknown", "PlannedStepsPending", `planned: ${planned.map(pairName).join(", ")}`)
          : declared.length > 0
            ? condition("Connected", "Unknown", "OrderNotInCode", `the code shows no link from one request to the next: ${declared.map(pairName).join(", ")}`)
            : condition("Connected", "True", "AllStepsConnected");

  const notListed = produces.filter((p) => !p.found);
  const producesListed = !produces.length
    ? condition("ProducesListed", "Unknown", "NotDeclared")
    : notListed.length
      ? condition("ProducesListed", "False", "NotInRegistry", notListed.map((p) => p.id).join(", "))
      : condition("ProducesListed", "True", "AllListed");

  // What only an author can write: the code shows the steps, not what the flow is for or what each component owns in it.
  const untitled = !object.metadata.title?.trim();
  const roleless = object.spec.steps.filter((s) => !s.role?.trim() && !s.flow).map((s) => s.stepId);
  const documented =
    untitled || roleless.length
      ? condition(
          "Documented",
          "False",
          untitled ? "TitleMissing" : "RoleMissing",
          [untitled ? "no title" : "", roleless.length ? `no role: ${roleless.join(", ")}` : ""].filter(Boolean).join("; "),
        )
      : condition("Documented", "True", "TitleAndRolesWritten");

  const rest = [resolved, connected, producesListed, documented];
  const failing = rest.filter((c) => c.status === "False");
  const ready = failing.length
    ? condition("Ready", "False", "ConditionsFailed", failing.map((c) => c.type).join(", "))
    : unresolved.length || planned.length
      ? condition("Ready", "Unknown", "PlannedStepsPending", `planned: ${[...unresolved.map((s) => s.stepId), ...planned.map(pairName)].join(", ")}`)
      : declared.length
        ? condition("Ready", "Unknown", "OrderNotInCode", `order stated by the flow only: ${declared.map(pairName).join(", ")}`)
        : condition("Ready", "True", "NoConditionFailed");
  return [ready, ...rest];
}

const TITLE = "flow description that the code does not bear out";

/** Whether a step or the one after it is planned, so the link between them is not expected to exist yet. */
function touchesPlanned(steps: StepStatus[], step: StepStatus): boolean {
  const next = steps[steps.indexOf(step) + 1];
  return step.lifecycle === "planned" || next?.lifecycle === "planned";
}

/** FA007 findings, derived from the conditions: what an active flow states and the graph does not show. */
export function flowFindings(report: FlowReport): Finding[] {
  const out: Finding[] = [];
  const add = (key: string, message: string, at: Place[]) => out.push({ rule: "FA007", key: `FA007|${key}`, title: TITLE, message, at });
  for (const f of report.files) {
    if (f.errors.length) add(`${f.file}|invalid`, `${f.file} does not follow the flow schema: ${f.errors.slice(0, 3).join("; ")}`, [{ file: f.file, line: 1 }]);
  }
  const seen = new Map<string, string>();
  for (const item of report.items) {
    const name = item.metadata.name;
    const [file, line] = (item.metadata.annotations?.[LOCATION] ?? ":1").split(/:(?=\d+$)/) as [string, string];
    const here = { file, line: Number(line) };
    if (seen.has(name)) {
      add(`${name}|duplicate`, `flow ${name} is described twice, also in ${seen.get(name)}.`, [here]);
      continue;
    }
    seen.set(name, file);
    const s = item.status;
    if (s.lifecycle === "deprecated" || s.lifecycle === "planned") continue;
    s.steps.forEach((step, i) => {
      const place = { file, line: step.line };
      if (!step.resolved && step.lifecycle === "active") add(`${name}|${step.stepId}|unresolved`, `step ${step.stepId} of ${name} names ${step.target}, which the code does not have.`, [place]);
      if (step.toNext && !step.toNext.connected && step.toNext.order !== "declared" && !touchesPlanned(s.steps, step)) {
        const next = s.steps[i + 1]!;
        add(`${name}|${step.stepId}|disconnected`, `nothing in the code leads from step ${step.stepId} (${step.target}) to step ${next.stepId} (${next.target}) of ${name}.`, [place, ...(step.at ? [step.at] : [])]);
      }
    });
    const documented = s.conditions.find((c) => c.type === "Documented");
    if (documented?.status === "False") add(`${name}|undocumented`, `${name} is not documented (${documented.message}); the title and each step's role are written by its author.`, [here]);
    for (const p of s.produces) if (!p.found) add(`${name}|produces|${p.id}`, `${name} produces ${p.id}, which no configured registry lists.`, [here]);
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
