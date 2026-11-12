# How traces connect

`atlas trace` joins two kinds of link: a call to the route it reaches (`=`), and a route's handler to the calls it
makes (`~`).

## A call joins a route (`=`)

A call joins a route when the method and path agree.

- **A call with no method.** Where atlas does not read the method (a project's wrapper around `fetch` that is given
  none, a `data-*` URL), the call joins the routes its path fits only when they all take one method. Where they take
  several, which one it calls depends on the method, so it joins none of them and a `limit:` line names it.
- **Wrappers.** A wrapper the configuration names in `calls[].wrappers`, with the method it sends by default (GET for
  one that hands its arguments to `fetch`), is read as `fetch` is.
- **Routes from an OpenAPI 3 document** are joined as the specification says: a concrete path (`/users/me`) before a
  templated one (`/users/{id}`). A call that leaves out the trailing `/` a document's path ends with joins it only by
  GET or HEAD, since what a server does with another method depends on its framework (a `limit:` names it).
- **Routes read from code** are joined as their framework dispatches:
  - where the router runs them in order, the first registered route a request fits, and the ones after it too where
    it may pass the request on (`next()`, Express's `next('route')`, a handler atlas does not see);
  - the most specific route where the router ranks them;
  - a trailing `/` as the framework treats it. A call the framework answers with a redirect (Next.js, Starlette) joins
    none, and a `limit:` names where it is redirected.

  The rules per framework are in
  [config.md](../skills/flow-atlas/references/config.md#which-route-a-request-reaches).
- **Generated clients.** A function of a client @hey-api/openapi-ts generated is a call only where another configured
  file's code names it, or names a generated helper that calls it.

## A handler joins its calls (`~`)

Inside a component, a route's handler is followed through local functions, relative imports and re-exports, and joins
an outbound call in two ways:

| Evidence | When |
|---|---|
| `static` | the handler's own code runs the request |
| `name` | the request sits in a method whose name the handler calls |

The second covers ports and adapters: the handler calls `deps.backend.getOrder()` and the adapter's `getOrder` makes
the HTTP request. Because it joins by name, a link through a common name such as `get` or `send` is worth opening.

## Requests a page offers next

- **Spring.** For a Spring page, the requests in the template its view name renders are its outbound calls
  (`via view <name>`), and so is the GET its `redirect:` leads to (`via redirect`).
- **Next.js.** For a Next.js page, the links and forms its server components and layouts render (`via view <file>`).

Either is a request the client makes next, not part of the page's own request.
