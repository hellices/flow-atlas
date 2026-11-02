import type { Finding, Findings, Place, RuleId } from "./model.js";
import { RULES } from "./rules.js";
import { VERSION } from "./provenance.js";

/**
 * Findings as SARIF 2.1.0 (OASIS), the format code-scanning services, IDE viewers and review bots read. The stable key
 * becomes a partial fingerprint, the baseline becomes baselineState, an exception becomes an accepted external
 * suppression with its reason, and the document's provenance travels in the run's property bag.
 */

const LEVEL: Record<RuleId, "error" | "warning" | "note"> = {
  FA001: "warning",
  FA002: "error",
  FA003: "warning",
  FA004: "warning",
  FA006: "note",
  FA007: "warning",
};

const NAME: Record<RuleId, string> = {
  FA001: "SurfaceWithoutCaller",
  FA002: "CallWithoutSurface",
  FA003: "UndeclaredBoundaryOrCycle",
  FA004: "RegistryEntryWithoutProducerOrConsumer",
  FA006: "UnusedContractVersion",
  FA007: "FlowNotBorneOut",
};

export const FINGERPRINT = "flowAtlasKey/v1";

const location = (p: Place, id?: number) => ({
  ...(id !== undefined ? { id } : {}),
  physicalLocation: { artifactLocation: { uri: p.file, uriBaseId: "%SRCROOT%" }, region: { startLine: p.line } },
});

export function toSarif(doc: Findings, inBaseline: (f: Finding) => boolean): object {
  const ruleIds = (Object.keys(RULES) as RuleId[]).sort();
  const results = doc.items.map(({ finding, status, note }) => {
    const [primary, ...related] = finding.at;
    return {
      ruleId: finding.rule,
      ruleIndex: ruleIds.indexOf(finding.rule),
      level: LEVEL[finding.rule],
      message: { text: finding.message },
      ...(primary ? { locations: [location(primary)] } : {}),
      ...(related.length ? { relatedLocations: related.map((p, i) => location(p, i + 1)) } : {}),
      partialFingerprints: { [FINGERPRINT]: finding.key },
      baselineState: inBaseline(finding) ? "unchanged" : "new",
      ...(status === "excepted"
        ? { suppressions: [{ kind: "external", status: "accepted", justification: (note ?? "").replace(/^exception: /, "") }] }
        : {}),
      ...(status === "expired-exception" && note ? { properties: { expiredException: note } } : {}),
    };
  });
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "flow-atlas",
            version: VERSION,
            rules: ruleIds.map((id) => ({
              id,
              name: NAME[id],
              shortDescription: { text: RULES[id].title },
              defaultConfiguration: { level: LEVEL[id] },
            })),
          },
        },
        originalUriBaseIds: { "%SRCROOT%": { description: { text: "The root of the repository atlas read." } } },
        results,
        properties: { provenance: doc.provenance },
      },
    ],
  };
}
