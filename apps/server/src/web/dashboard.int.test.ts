import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type Database } from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger.ts";
import { composeServices } from "../services.ts";

const { createApp } = await vi.importActual<typeof import("../app.ts")>("../app.ts");

const index = "<!doctype html><html><body>Dashboard fixture</body></html>";
const asset = 'document.body.dataset.loaded = "true";';

describe("production dashboard routing", () => {
  let webDir: string;
  let testDb: TestDatabase;
  let db: Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    webDir = await mkdtemp(join(tmpdir(), "helpos-dashboard-"));
    await mkdir(join(webDir, "assets"));
    await writeFile(join(webDir, "index.html"), index);
    await writeFile(join(webDir, "assets", "app-a1b2c3.js"), asset);
    testDb = await startTestDatabase();
    db = createDatabase(testDb.appUrl);
    app = createApp(
      composeServices({
        db,
        files: createMemoryFileStore(),
        logger: createLogger({ level: "silent" }),
        config: { webDir },
      }),
    );
  });

  afterAll(async () => {
    await db?.close();
    await testDb?.stop();
    if (webDir) await rm(webDir, { recursive: true, force: true });
  });

  it.each([
    { path: "/", body: index, type: "text/html", cache: "no-cache" },
    { path: "/index.html", body: index, type: "text/html", cache: "no-cache" },
    { path: "/conversations/example", body: index, type: "text/html", cache: "no-cache" },
    { path: "/v1-looking-page", body: index, type: "text/html", cache: "no-cache" },
    { path: "/assets/missing.js", body: index, type: "text/html", cache: "no-cache" },
    {
      path: "/assets/app-a1b2c3.js",
      body: asset,
      type: "text/javascript",
      cache: "public, max-age=31536000, immutable",
    },
  ])("serves $path with dashboard protections", async ({ path, body, type, cache }) => {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(type);
    expect(await res.text()).toBe(body);
    expect(res.headers.get("cache-control")).toBe(cache);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const directives = res.headers
      .get("content-security-policy")
      ?.split(";")
      .map((s) => s.trim());
    expect(directives?.sort()).toEqual(
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].sort(),
    );
  });

  it.each([
    { path: "/health", status: 200, body: { status: "ok" } },
    { path: "/openapi.json", status: 200, body: { openapi: "3.1.0" } },
    { path: "/v1/conversations", status: 401, body: { error: "unauthorized" } },
    { path: "/v1", status: 404, body: { error: "not_found" } },
    { path: "/v1/", status: 404, body: { error: "not_found" } },
    { path: "/v1/does-not-exist", status: 404, body: { error: "not_found" } },
  ])("keeps $path a JSON API response", async ({ path, status, body }) => {
    const res = await app.request(path);
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toContain(
      status >= 400 ? "application/problem+json" : "application/json",
    );
    expect(await res.json()).toMatchObject(body);
    for (const header of [
      "content-security-policy",
      "x-frame-options",
      "referrer-policy",
      "cache-control",
    ]) {
      expect(res.headers.get(header), header).toBeNull();
    }
  });
});
