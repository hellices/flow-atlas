import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import AjvDraft04Module from "ajv-draft-04";

const AjvDraft04 = (AjvDraft04Module as unknown as { default: typeof AjvDraft04Module }).default ?? AjvDraft04Module;

const load = (name: string): object => JSON.parse(readFileSync(new URL(`./standards/${name}`, import.meta.url), "utf8"));

/** Violations of the official SARIF 2.1.0 schema (draft-04). */
export function sarifErrors(doc: unknown): string[] {
  const ajv = new (AjvDraft04 as unknown as typeof Ajv2020)({ allErrors: true, strict: false, validateFormats: false });
  const validate = ajv.compile(load("sarif-schema-2.1.0.json"));
  return validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

/** Violations of the official Arazzo 1.0 schema (2020-12). */
export function arazzoErrors(doc: unknown): string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  const validate = ajv.compile(load("arazzo-schema-1.0.json"));
  return validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}
