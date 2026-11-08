import { isAbsolute, relative } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";

/** Paths the API owns. Everything else is the dashboard. */
export function isApiPath(path: string): boolean {
  return (
    path === "/health" || path === "/openapi.json" || path === "/v1" || path.startsWith("/v1/")
  );
}

/**
 * The dashboard's Content Security Policy (ADR 0004). Scripts only from our own files, so even
 * HTML that slipped past the sanitiser can't run one. Images only from us or inlined, which
 * blocks remote tracking pixels in emails. The email iframe uses `srcdoc`, so it inherits this
 * policy on top of its own. Inline styles are allowed: emails are laid out with them, and the
 * motion library injects a few; with scripts locked down they can't do more than style.
 */
export const dashboardCsp = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:"],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  frameSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

/**
 * Serves the built dashboard (apps/web/dist) from the same origin as the API, so the session
 * cookie needs no CORS. Unknown paths get index.html: the dashboard routes them itself.
 */
export function registerDashboard(app: OpenAPIHono, webDir: string): void {
  // serveStatic resolves `root` against the working directory.
  const root = isAbsolute(webDir) ? relative(process.cwd(), webDir) || "." : webDir;
  const onlyDashboard =
    (handler: MiddlewareHandler): MiddlewareHandler =>
    (c, next) =>
      isApiPath(c.req.path) ? next() : handler(c, next);

  app.use(
    "*",
    onlyDashboard(
      secureHeaders({
        contentSecurityPolicy: dashboardCsp,
        referrerPolicy: "no-referrer",
        xFrameOptions: "DENY",
        crossOriginResourcePolicy: "same-origin",
      }),
    ),
  );
  app.get(
    "*",
    onlyDashboard(
      serveStatic({
        root,
        onFound: (path, c) => {
          // Vite puts a content hash in every file name under assets/.
          c.header(
            "cache-control",
            path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
          );
        },
      }),
    ),
  );
  app.get(
    "*",
    onlyDashboard(
      serveStatic({
        root,
        path: "index.html",
        onFound: (_path, c) => {
          c.header("cache-control", "no-cache");
        },
      }),
    ),
  );
}
