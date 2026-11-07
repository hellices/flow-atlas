# Interpreting boundaries

atlas shows what the code does. Whether that is what each component should do is your judgment. These criteria keep
that judgment consistent between agents and sessions. Record every conclusion in a file atlas reads: the flow file,
the exceptions file or the configuration.

## Which source decides

When sources disagree, follow them in this order:

1. The repository's own rules: AGENTS.md, design documents or ADRs, component manifests (`component.json`, `catalog-info.yaml`),
   governance tests. They state the agreed responsibilities.
2. The flow files' `role` of each step, which record what each component does in a flow.
3. The code. It shows what was built, not what was agreed; a gap between code and the two above is the finding.

If the rules and the roles disagree, the roles are stale or the rules changed; raise it with a person instead of
picking one.

## Does this hop belong to this component?

Read `atlas trace` for the surface and ask for each hop:

- Does the component's agreed responsibility cover this step? If a BFF reads a record it should only forward, or a
  service shapes a screen, the hop is in the wrong place even when everything connects.
- Is the same step done elsewhere? `atlas query --path <fragment>` and the operationIds show twins. Two surfaces in
  different components with the same purpose are duplication; prefer extending the owner's surface.
- Does a hop skip the component that should mediate it? A client calling a service directly (FA003 undeclared edge)
  usually does.

Write the conclusion as the step's `role`: what the component does, and what it leaves to the others.

## Where does a flow start and end?

Cut flows at units a person names: one screen's load, one user action, one background job. One request is one chain:
atlas starts it at the component that makes the request and takes in everything the handler reaches, fan-out
included, so you do not choose among the services a handler calls. A journey across several requests is a flow whose
steps are chains in order; take each following chain from the previous chain's `next` where atlas lists one. Do not
split a chain into steps by hand to tell a story the code does not hold.

## Defect, plan, or false positive?

- Defect: the code differs from an agreement, and nothing records why. An agreement is a repository rule or design
  document, or a flow merged through a reviewed pull request. Fix it.
- Open question: the code differs from a flow nobody has reviewed yet. Its roles are a proposal (see "How far to trust a flow's intent"): ask a person whether the code or
  the flow is right before calling it a defect.
- Plan: the gap is intended, such as a provider built before its client. A decision or issue says so. Mark the step
  or flow `lifecycle: planned`, or add an exception with `decidedBy` and `reviewBy`.
- False positive: atlas misread the code (a path built far from the call, a string that is not a request). Correct
  the configuration if it caused the misreading; otherwise add an exception whose reason names the misread file and
  how, and report it so the extractor can be fixed.

Never decide "plan" without a decision you can link.

## How far to trust an edge

- `=` (evidence `static`): a call matched a route by method and path. Reliable when the call file is a real client.
- `~` (evidence `static`): the outbound call is written in code the handler runs (its body or a function it calls).
  Reliable.
- `~` (evidence `name`, `via view <name>`): a Spring page handler renders the template whose requests these are, found
  where Spring Boot's default Thymeleaf resolver looks (`src/main/resources/templates/<name>.html` of the handler's
  application). An app that uses another template engine or `ViewResolver`, or changed the Thymeleaf prefix or suffix,
  renders something else: check its resolver before trusting the edge.
- `~` (evidence `text`, `via redirect`): a Spring handler's reply redirects (`redirect:/owners/{id}`), and the client
  that made the request follows it with a GET; the request is the client's next one, not part of this one. Read as
  text: check the line when the URL is built in code.
- `~` (evidence `name`): a handler calls a method with the name of the method holding an outbound call. Check the code
  when the name is generic (`get`, `send`, `request`) or the component has several clients.
- evidence `text`: read as text in a language atlas does not parse. Check the line.
- Absence proves little: only configured files are read. Before concluding "nobody calls this", look at the coverage
  in `atlas scan` and search the code once.

## Which API description is the component's?

`atlas scan` decides it when the code does: the author's `openapi` entry; the one committed file that declares every
route the component serves (`FileMatchesCode`); otherwise the one served document, with swagger-ui pages that show it
collapsed into it (`ServedByCode`, `AliasesOfOne`). It reports `ambiguous` instead of guessing when several candidates
fit equally. Then choose, and write the choice as `openapi.<component>` with a comment saying why:

- Follow the repository's rules first. A design-first repository (the committed description is the contract, code is
  generated or checked against it) means the committed file; a code-first one means the served document.
- springdoc groups (`SeveralServedDocuments` with `/v3/api-docs/<group>` candidates): a group whose builder (or
  `springdoc.group-configs` entry) sets `pathsToMatch` and nothing else that filters can be judged from its patterns:
  take it when they cover the component's routes. A group that also or instead uses `packagesToScan`,
  `pathsToExclude`, `packagesToExclude`, `producesToMatch`, `consumesToMatch`, `headersToMatch` or a customizer cannot:
  generate its document (`references/openapi.md`) and compare its paths, or ask. Otherwise take the ungrouped
  `/v3/api-docs`, which documents the routes springdoc sees: `springdoc.paths-to-match` and
  `springdoc.packages-to-scan` narrow it, and `@Hidden` (`io.swagger.v3.oas.annotations.Hidden`) on a handler or
  controller, or a customizer, removes routes from every document. Where the code uses either, generate the document
  and compare its paths before taking it as the component's. Modules of one application may each take a different
  group.
- Several served documents (`SeveralServedDocuments`), such as `/v1` and `/v2`: take the one whose paths the flow's
  clients call; `atlas query --path` shows which version the calls use.
- Several complete files (`SeveralCompleteFiles`): usually one is a copy (in `docs/`, a build output, another
  package). Take the source and add the copy's directory to `exclude`.
- Only partial files (`SeveralPartialFiles`, `OnlyPartialFile`): they are stale snapshots. Say so to a person; do not
  present a stale snapshot as the component's API. The `agreement.missing` list shows what each one lacks.

A committed file that lacks routes next to a chosen served document is drift worth reporting even when nothing is
ambiguous; `atlas scan` prints it with the choice.

## How far to trust a flow's intent

A flow file merged through a reviewed pull request is an agreement: change its roles only with a person. A flow added
or changed in the current, unmerged change, or one written by an agent and not yet reviewed, is a proposal: use it,
but when a boundary decision rests on it, say so and ask a person to confirm.

## What not to decide

Do not decide the configuration's scope, the baseline, or which rules apply to the repository on your own. Propose them
to a person with the evidence (`atlas inventory`, `atlas scan` coverage, the findings you judged and why).
