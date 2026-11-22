# Reading atlas's output

atlas reports evidence, not verdicts: what the code settles under each technology's documented rules, and where it
stopped. Judging what the evidence means for a flow (a defect, a plan, a misreading) is yours, or a person's.

## Where reading stopped

- Every `limit:` line names where reading stopped and why, with the file, line and expression. A chain or a finding
  ends there, not because nothing follows: open the code at that place before concluding anything, and fix the
  configuration if it is the cause. What you read there stays out of the flow file; atlas would not check it.
- atlas does not try to read every form code can take, and it will not grow a reading for one repository's code. Where
  a `limit:` names a configuration entry (a function whose parameter holds a path: declare it in that route entry's
  `calls`; a client wrapper, a base, a mount), setting it is yours. Where none fits, read the code at the place named
  and judge it yourself.
- Only configured files are read, and in them only what is written for certain: literal paths, with the meaning a
  standard or the framework gives them. A URL from a variable, another template engine, or htmx and Vue attributes
  is not read and not guessed. So "no caller" means none that atlas can read; check the code before removing anything,
  and declare surfaces served outside the repository in `publicSurfaces`. No finding does not prove a flow is complete.

## Findings and counts

- A finding's message carries the facts it rests on: a call that fits a route only by the value of an interpolated
  segment while another route takes every value, a target whose route sources yielded no route, the earlier route
  that takes every request. Weigh those facts; a finding is where to look, not what to do.
- Each fact is reported once, under one key, at one place: the same route read from two sources is one surface, an
  edge is joined once with its evidence. Count findings and chains as atlas lists them, each once, rather than adding them up
  from `scan`, `query` and `trace` output.
- `atlas check` starts and ends with the counts. Its last line splits the calls: matched, unserved (FA002), not
  decided (a `limit:` line says why), not taken for requests, and not checked (no route source for the target, or
  FA002 off). Only "unserved" is a finding. Calls listed as reaching a route only an OpenAPI document declares go to a
  route the code was not found to have: a hand-written contract given as a route source, or a handler atlas did not
  find. Open the code before calling either built.
- Finding status: `new` is yours; `baseline` is accepted debt; `excepted` is covered; `expired-exception` needs a
  person.

## Traces

- `=` joins a call to a surface by method and path.
- `?` joins one that fits it only where an interpolated segment of the call takes the route's fixed text
  (`/v1/${route}` and `/v1/orders`), which `query` marks `(by value)`: whether the call sends that path is not in the
  code, so read the call before counting it as a caller.
- `~` joins a route to an outbound call its handler runs: written in the handler's own code or the functions it calls
  (evidence `static`), or held in a method of a name the handler calls (evidence `name`; a Python handler a decorator
  registers joins only so, one call deep), or, for a Spring page, made by the template its view name renders
  (`via view <name>`) or sent by the client that follows its redirect (`via redirect`). A `~` by name through a generic
  name (`get`, `send`) needs a look at the code.
- Where a trace says a handler is not followed, or a `limit:` says a component's chains stop at its surfaces, what its
  handlers call is not in atlas's output.
- A call's `in <name>` is the function holding the string. A string in an error label or a log message is not a
  request even if it looks like a path; the scope usually shows that.

## Machine-readable output

`--format json` or `--format yaml` prints documents that follow the flow-atlas package's `schema/*.schema.json`, each
with `apiVersion`, `kind` and `provenance` (the commit and files read, with digests). Read these instead of parsing the
text output; branch on a condition's `reason`, not its `message`. `atlas check --format sarif` gives the findings as
SARIF 2.1.0 for code-scanning and IDE viewers; `atlas export arazzo` prints the flows as Arazzo 1.0 for API workflow and
e2e tools, which still need parameters, request bodies and success criteria filled in. It writes nothing to `--out`:
save its output at the repository root (`atlas export arazzo > flows.arazzo.yaml`), since the description files it
names in the repository are relative to the root.
