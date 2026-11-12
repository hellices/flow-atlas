# Official schemas used by the tests

The tests check atlas's exports, and the repository's own `plugin.json`, against these files, unchanged from their publishers.

| File | Standard | Source |
|---|---|---|
| `sarif-schema-2.1.0.json` | OASIS SARIF 2.1.0 (errata 01) | https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json |
| `arazzo-schema-1.0.json` | OpenAPI Initiative Arazzo 1.0 | https://spec.openapis.org/arazzo/1.0/schema/2025-10-15 |
| `agent-plugins-plugin-schema-1.0.0.json` | Agent Plugins 1.0.0 `plugin.json` | https://agent-plugins.org/schemas/1.0.0/plugin.schema.json |

These files are third-party material under their publishers' terms (OASIS for SARIF, the OpenAPI Initiative's Apache-2.0 for Arazzo, the Agent Plugins project's Apache-2.0 for its schema), not under this repository's MIT license. They are used only by the tests and are not part of the package.
