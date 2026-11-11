# Rules

`atlas` reports a finding and its facts; the resolutions below are for you to weigh. `atlas explain <key>` adds the
calls or surfaces with a similar path, which usually tells a typo from a missing piece.

Each rule reports facts from configured files only. A key identifies a finding across commits, so the
baseline and exceptions refer to it.

## FA001 surface with no caller in the repository

Key `FA001|<component>|<METHOD> <path>`.

A route served by a component that some configured client calls, where no configured call site matches the
route's method and path. Surface paths are OpenAPI templates (a Nest or Express `:id` reads `{id}`); path
parameters (`{id}`, `*`) match any segment; interpolations in a call
match any segment. A call reaches the route its framework dispatches it to (see config.md, "Which route a request
reaches"), so a route that an earlier one of its router always answers for is reached by none: the finding names the
route that takes its requests. A route that a call of unread method may reach, among routes of several methods, is not
reported, nor is one that a call without the trailing `/` its OpenAPI document writes may reach by a method other than
GET or HEAD, one a call reaches only after its router's trailing-slash redirect, or one taken only with headers that
meet its constraints (Fastify's); a `limit:` line names that call. A route the framework serves by itself (`implicit`:
FastAPI's OpenAPI document, Spring Boot's error page and static resources, Next.js's public files and build files) is
not reported either.

Common causes: the provider was built ahead of its client; the client was removed or renamed; the client builds
the path in a way the extractor cannot read (a URL returned by the server, a path assembled across functions); the
only caller is a function of a generated client that no configured file calls (a `limit:` names it).

Fix: add or wire the caller, or remove the route. If a client outside the repository uses it, add it to
`publicSurfaces`. If the provider deliberately ships first, add an exception with a `reviewBy` date.

## FA002 call that no surface serves

Key `FA002|<from>-><to>|<METHOD> <path>`.

A configured call site whose request matches no route of its target. Reported only when the target has route
sources in the configuration (even if none of its routes is left) and the request is clearly a path on that target:
it starts from a base address, or its first segment is one the target serves.

A call of unread method whose path fits routes of several methods is not reported either: it may reach any of them,
so atlas leaves it unmatched rather than link it to one, and a `limit:` line names it. The same holds for a call
that leaves out the trailing `/` of its route's document path, by a method other than GET or HEAD, for one its router
answers with a redirect to the path with the `/` added or removed (Next.js's `trailingSlash`, Starlette's
`redirect_slashes`), which reaches the route there once the client follows it, and for one whose route takes only
requests whose headers meet its constraints. A call that no route takes as its framework dispatches is reported: a
path with a trailing `/` on a router that tells it apart (Fastify, Hono, Spring 6 and later), or a value a parameter's
matcher refuses (AdonisJS), is answered with 404 or 405. A route the framework serves by itself takes a call as any
route does: a GET that no other route of a Spring Boot application takes reaches its static resources (`/**`), as
Spring dispatches it, and is not reported, unless `spring.web.resources.add-mappings` is false.

Common causes: a route was renamed or removed while a client kept the old path; a method mismatch;
a typo in a path segment.

Fix: point the call at the served path, or restore the route. Do not add a route only to silence the finding
unless the behavior is wanted.

## FA003 undeclared component edge, or a cycle

Keys `FA003|undeclared|<from>-><to>` and `FA003|cycle|<a>-><b>->...`.

An edge is a call that matched a route of another component. When the configuration reads component manifests,
an actual edge missing from their declarations is reported, also when the manifests declare nothing. Cycles are
reported over declared and actual edges together, at any length; in a very dense graph the search stops early,
says so in a `limit:` line, and still reports at least one cycle per group of components that reach each other. Set
`rules.FA003.cycles: false` when the repository already checks cycles itself.

Fix: declare the dependency through the repository's own process, or route the call through the component that
owns it. Break a cycle by moving the shared responsibility, not by hiding the call.

## FA004 registry entry without a producer or consumer

Keys `FA004|<registry>|<entry>|no-producer`, `|no-consumer`, `|unused`.

A registry lists entries (artifacts, tools, events) that one side produces and another consumes. Each active
entry is looked up by name, with word boundaries, in the producer and consumer files.

Common causes: a renderer exists for an artifact nothing issues; a producer issues something no client renders;
an entry left active after its feature was removed.

Fix: add the missing side, or deactivate the entry. A producer that names entries indirectly (a generated map,
a computed name) needs its source file added to `producers`.

The lookup is by name, so it fits only registries whose entries both sides name in code. When most findings of a
registry are entries kept in data, served by one generic route or rendered generically, remove the registry from the
configuration rather than excepting each entry.

## FA007 flow description that the code does not bear out

Keys `FA007|<flow>|<step>|unresolved`, `|<step>|disconnected`, `|produces|<entry>`,
`|undocumented`, `|duplicate`, and `FA007|<file>|invalid`.

An active Flow in `flows/*.flow.yaml` names a surface or call the code does not have, two consecutive surface or call steps with
no chain of edges between them, a registry entry no registry lists, a sub-flow step naming a flow nobody describes, or an empty title or step role. Each corresponds to a False
condition in `atlas flows` (`Resolved`, `Connected`, `ProducesListed`, `Documented`). Two consecutive chain steps
with no `next` linking them are not a finding: the code neither shows nor contradicts their order, so `Connected` is
`Unknown (OrderNotInCode)` and the order stays the author's. `undocumented`
is the only one about the author's part rather than the code: write the title and each step's role. An invalid file does not follow `flow.schema.json` and is
not resolved at all.

Common causes: a route was renamed and the description was not; a hop was moved to another component; a handler
reaches the next service through a path the extractor cannot follow; the step does not exist yet.

Fix: correct the description or the code, whichever is wrong, and say which in the PR. Mark a step or flow that is
not built yet `lifecycle: planned`; mark a flow that is going away `lifecycle: deprecated`. A `disconnected` step whose code is in
fact connected usually means the call sits outside the configured `calls` files or in a method the handler does not
reach by name; check `atlas trace` on the first step.

## Not yet implemented

FA005, contract fields that are produced but never read, needs schema and type information beyond text matching.
