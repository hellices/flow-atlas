import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

const FILES = ["model", "graph", "subgraph", "findings", "diff", "inventory", "flow", "flow-report"] as const;
export type SchemaName = (typeof FILES)[number];

let ajv: Ajv2020 | undefined;

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/** An RFC 3339 date-time (seconds required) whose fields are in range: a real calendar day, hours to 23, minutes to 59, seconds to 60 (leap). */
export function isDateTime(value: string): boolean {
  const m = DATE_TIME.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second, , offH = "0", offM = "0"] = m.slice(1).map((x) => x ?? undefined) as string[];
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return (
    Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days &&
    Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 60 && Number(offH) <= 23 && Number(offM) <= 59
  );
}
const compiled = new Map<SchemaName, ValidateFunction>();

function load(): Ajv2020 {
  if (ajv) return ajv;
  ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  ajv.addFormat("date-time", { type: "string", validate: isDateTime });
  for (const f of FILES) ajv.addSchema(JSON.parse(readFileSync(new URL(`../schema/${f}.schema.json`, import.meta.url), "utf8")));
  return ajv;
}

/** Schema violations of a value as readable lines; empty when it conforms. */
export function validate(name: SchemaName, value: unknown): string[] {
  let fn = compiled.get(name);
  if (!fn) {
    fn = load().getSchema(`urn:flow-atlas:schema:v1alpha1:${name}`)!;
    compiled.set(name, fn);
  }
  if (fn(value)) return [];
  return (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}${e.params && "allowedValues" in e.params ? ` (${(e.params.allowedValues as unknown[]).join(", ")})` : ""}`);
}

const BY_KIND: Record<string, SchemaName> = {
  Graph: "graph",
  Trace: "subgraph",
  Query: "subgraph",
  Findings: "findings",
  Diff: "diff",
  Inventory: "inventory",
  Flow: "flow",
  FlowReport: "flow-report",
};

/** The schema a document of a kind conforms to. */
export function schemaForKind(kind: string): SchemaName | undefined {
  return BY_KIND[kind];
}
