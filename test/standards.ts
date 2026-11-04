import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import AjvDraft04Module from "ajv-draft-04";
import { isDateTime } from "../src/schema.js";

const AjvDraft04 = (AjvDraft04Module as unknown as { default: typeof AjvDraft04Module }).default ?? AjvDraft04Module;

/** The text of a vendored standard schema, parsed. Throws when the file is not complete JSON. */
const loadStandard = (name: string): object => JSON.parse(readFileSync(new URL(`./standards/${name}`, import.meta.url), "utf8"));

/** RFC 3986 URI-reference: only characters a URI may hold, `%` followed by two hex digits, at most one `#`. */
function isUriReference(value: string): boolean {
  return /^(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})*$/.test(value) && value.split("#").length <= 2;
}

/** RFC 3986 URI: a URI-reference that starts with a scheme. */
const isUri = (value: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && isUriReference(value);

const FORMATS = { "date-time": isDateTime, uri: isUri, "uri-reference": isUriReference };

function withFormats<T extends { addFormat(name: string, format: { type: "string"; validate: (v: string) => boolean }): unknown }>(ajv: T): T {
  for (const [name, validate] of Object.entries(FORMATS)) ajv.addFormat(name, { type: "string", validate });
  return ajv;
}

/** Violations of the official SARIF 2.1.0 schema (draft-04), formats included. */
export function sarifErrors(doc: unknown): string[] {
  const ajv = withFormats(new (AjvDraft04 as unknown as typeof Ajv2020)({ allErrors: true, strict: false }));
  const validate = ajv.compile(loadStandard("sarif-schema-2.1.0.json"));
  return validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

/** Violations of the official Arazzo 1.0 schema (2020-12), formats included. */
export function arazzoErrors(doc: unknown): string[] {
  const ajv = withFormats(new Ajv2020({ allErrors: true, strict: false }));
  const validate = ajv.compile(loadStandard("arazzo-schema-1.0.json"));
  return validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}
