# Tool, agent and skill: who does what

flow-atlas has three parts. The tool generates what the code settles. An agent (or a person) writes what needs intent,
and the tool checks it. Between the two, the skill gives the criteria for reading which work belongs to which
component.

## Where the line is

If the same inputs always give the same answer and the code can confirm it, it is the tool's job. An LLM doing it would
answer differently each time and spend tokens on every repetition of the question.

If the answer needs intent or context outside the code, it is the agent's job. What a flow is for, what each component
owns in it, whether a finding is a defect or a planned state: none of this is written in the code. A tool that guessed
would leave plausible wrong answers looking like facts.

What the agent decides goes only into files the tool reads back: flow files, the exceptions file and the configuration.
The tool never writes these files; even a draft goes to standard output, and the agent saves it. So the files
alone show whether a value came from the code or from a person.

## What the tool generates

| Output | Command | From |
|---|---|---|
| routes, calls, edges, operationIds | `scan` | parsed code and the files the configuration names; for a framework atlas cannot parse, the OpenAPI document that framework generates |
| locations of each component's OpenAPI documents | `scan`, `inventory` | committed files such as `openapi.yaml`, and the paths the code serves a document at (`SwaggerModule.setup`, `@fastify/swagger-ui`, an `/openapi.json` route, springdoc's `/v3/api-docs` and its groups) |
| which description is a component's, when there are several | `scan` | paths that show the same document are one; a committed file is compared with the routes the code serves. If the code cannot decide, nothing is chosen and the result is `ambiguous` |
| producers and consumers of registry entries | `scan` | names searched in files |
| routes and calls by path or component | `query` | the graph |
| what leads to a route and what it leads to | `trace` | graph edges |
| chains: each request, everything it reaches in that request, who makes it, what may follow it | `chains` | graph edges; a page's template links and forms are what may follow, not part of the request |
| a flow draft per chain: name, step, chain and entry | `draft flows` | the chains |
| whether a flow holds in the code | `flows` | steps resolved, paths between steps (between chains, a `next` the code offers), registry lists |
| whether the author's fields are written | `flows` (`Documented`) | a title and each step's role present |
| findings FA001, FA002, FA003, FA004 and FA007 | `check` | the facts above |
| routes, links, chains and findings that changed | `diff` | the graphs of two revisions |
| configuration candidates | `inventory` | manifests and file shapes |
| how much of the code the configuration covers | `scan`, `check` | what each configured source read, and drops against the baseline |
| SARIF and Arazzo skeletons | `check --format sarif`, `export arazzo` | the results above, converted |

The tool does not decide how to fix anything. `explain` shows only the locations and similar paths.

## What the agent fills in

| Field | Why the tool cannot | How the tool checks it |
|---|---|---|
| a flow's title (`metadata.title`) | what a flow is for is not in the code | `Documented` |
| each step's role (`steps[].role`) | what a component takes on and leaves to others is an agreement | `Documented` |
| owner, labels, source documents (`sources`) | organisational and documentary facts | schema |
| a flow's state (`lifecycle`) | whether a missing step is planned or a defect is intent | planned steps are counted apart in `Resolved` |
| a journey: which chains, in which order | which requests a person makes one after another is intent; take each from atlas output | `Resolved`; `Connected` from a chain's `next`, otherwise Unknown (`OrderNotInCode`) |
| on a surface-step flow only: the next step where a handler branches | a surface-step flow leaves this choice; a chain step does not | `Resolved`, `Connected` |
| registry entries a flow issues (`produces`) | which artifact is this flow's result is intent | `ProducesListed` |
| an exception's reason, the decision behind it and a date to review | why something is fine for now is a decision | when the date passes, the finding returns |
| a misread file: which file and how, as an exception's reason | whether extraction went wrong takes reading the code | the exception's review date |
| the configuration | which files are clients differs per repository | `scan` coverage |
| OpenAPI documents frameworks generate (`routes[].openapi`) | generating one runs the application's code; the tool only reads files | `scan` coverage and `limit:` lines |
| server addresses per environment (`origins`) | the code knows document paths; where a server runs is the deployment's business | `export arazzo` notes a missing one |
| the choice when a description is `ambiguous` (`openapi.<component>`) | contract-first or code-first, and which version is this flow's, are the repository's decisions | `export arazzo` stops until it is set |
| Arazzo parameters, request bodies, success criteria | the values a run needs do not come from the code | the tool that runs the Arazzo document |

## The boundary reading the skill guides

Given the facts the tool shows, this is the judgment of which work belongs to which component. The skill gives the
criteria and the order to apply them in; the details are in the skill's `references/boundaries.md`.

| Judgment | Criterion |
|---|---|
| Does this hop belong to this component? | follow the repository's rules (AGENTS.md, design documents, manifests), then the flow's roles, then the code |
| Is there already a route that does this? | look for similar paths and operationIds with `query`; if roles overlap, do not add another |
| Fix, exception, or false positive? | if the code differs from the intent, fix it; if the order is intended, record the decision as an exception; if extraction went wrong, correct the configuration or record the misread file as an exception |
| Can a name-joined edge (`~`) be trusted? | if it passes through a common name such as `get` or `send`, open the code |
| Where does a flow start and end? | at units a person names: one screen, one request |
| Is a missing step planned or a defect? | with a decision or an issue, planned (`planned`); without, a defect |

## Writing one flow

Take the drafts from `atlas draft flows`: each is one chain, with its entry from the code. Fill only the fields marked
`agent:`. For a journey, list chains in order, each following one taken from the previous chain's `next` where atlas
lists one. Repeat `atlas flows` until it reports `Ready=True`. A False `Resolved`
or `Connected` means the code or the flow is wrong; which one is decided with the boundary criteria. A
False `Documented` means a field the author writes is empty.

## What keeps the line in place

The structure of a flow is atlas's: a chain step carries no surfaces, edges or entry written by hand, and a journey
can only order chains atlas lists. The structural conditions (`Resolved`, `Connected`) fail only on a fact from the code. What
the author writes is checked for presence and validity, not for meaning: `Documented` and FA007 fail on an empty title
or role, the schema check on an invalid field; none of those says the code is wrong. A person reviews the intent in
the pull request that changes the flow file. The flow schema says in each field's description who
writes it (`author`, `from atlas`). The tool writes neither flow files nor the exceptions file, and prints drafts to
standard output only. The baseline is updated only when a person asks.
