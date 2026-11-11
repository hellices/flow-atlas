import type { Surface } from "../src/model.js";

/** The settings FastAPI's own documentation routes come from, by the path each has by default. */
const DOCUMENTATION: Record<string, string> = {
  "fastapi openapi_url": "/openapi.json",
  "fastapi docs_url": "/docs",
  "fastapi swagger_ui_oauth2_redirect_url": "/docs/oauth2-redirect",
  "fastapi redoc_url": "/redoc",
};

/**
 * Whether a surface is one of the documentation routes FastAPI serves by itself at its default path, under where the
 * application is served: the tests whose subject is another rule leave these out, which test/served.test.ts reads.
 */
export const fastapiDocumentation = (s: Pick<Surface, "convention" | "implicit" | "path" | "method">): boolean =>
  !!s.implicit && (s.method === "GET" || s.method === "HEAD") && !!s.convention && Object.hasOwn(DOCUMENTATION, s.convention) && s.path.endsWith(DOCUMENTATION[s.convention]!);
