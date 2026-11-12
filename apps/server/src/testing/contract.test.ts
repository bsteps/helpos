import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { contractApp } from "./contract.ts";

type ResponseConfig = Exclude<RouteConfig["responses"][string], { $ref: string }>;
type Media = NonNullable<ResponseConfig["content"]>[string];
type Fixture = {
  schema?: Exclude<NonNullable<Media>, { $ref: string }>["schema"];
  body?: string;
  status?: number;
  media?: string;
  declaredMedia?: string;
  declaredStatus?: string;
};
function fixture({
  schema = { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
  body = '{"id":1}',
  status = 200,
  media = "application/json",
  declaredMedia = "application/json",
  declaredStatus = "200",
}: Fixture = {}) {
  const app = contractApp(new OpenAPIHono());
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/things/{id}",
    responses: {
      [declaredStatus]: { description: "Test response", content: { [declaredMedia]: { schema } } },
    },
  });
  app.get("/things/:id", () => new Response(body, { status, headers: { "content-type": media } }));
  return app;
}

function referencedResponse(ref: string, body: string | null = null) {
  const app = contractApp(new OpenAPIHono());
  app.openAPIRegistry.registerComponent("responses", "Payload", {
    description: "JSON payload",
    content: {
      "application/json": {
        schema: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
      },
    },
  });
  const alias = { description: "Response alias", $ref: ref };
  app.openAPIRegistry.registerComponent("responses", "Alias", alias);
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/references",
    responses: { 200: { $ref: "#/components/responses/Alias" } },
  });
  app.get(
    "/references",
    () => new Response(body, { headers: { "content-type": "application/json" } }),
  );
  return app;
}

describe("the integration response boundary", () => {
  it("resolves response reference chains before checking the required body", async () => {
    const ref = "#/components/responses/Payload";
    await expect(referencedResponse(ref).request("/references")).rejects.toThrow();
    await expect(referencedResponse(ref, '{"id":"wrong"}').request("/references")).rejects.toThrow(
      "response schema mismatch",
    );
    expect(await (await referencedResponse(ref, '{"id":1}').request("/references")).json()).toEqual(
      {
        id: 1,
      },
    );
  });

  it.each([
    ["https://example.invalid/response.json", "external response refs are unsupported"],
    ["#/components/responses/Alias", "cyclic response ref"],
    ["#/components/responses/Missing", "undeclared response status"],
  ])("rejects the unresolved response alias %s", async (ref, message) => {
    await expect(referencedResponse(ref).request("/references")).rejects.toThrow(message);
  });

  it("uses the matched path, method and status and preserves the original body", async () => {
    const app = fixture();
    const res = await app.request(new Request("http://localhost/things/42?view=full"));
    expect(res.bodyUsed).toBe(false);
    expect(await res.json()).toEqual({ id: 1 });
    await expect(app.request("/things/42", { method: "POST" })).rejects.toThrow(
      "undeclared response media",
    );
  });

  it("rejects malformed output, undeclared statuses and media", async () => {
    await expect(fixture({ body: '{"id":"wrong"}' }).request("/things/42")).rejects.toThrow(
      "response schema mismatch",
    );
    await expect(fixture({ status: 201 }).request("/things/42")).rejects.toThrow(
      "undeclared response status",
    );
    await expect(fixture({ media: "text/plain" }).request("/things/42")).rejects.toThrow(
      "undeclared response media",
    );
    await expect(fixture({ body: "not JSON" }).request("/things/42")).rejects.toThrow();
  });

  it("validates non-JSON text, media ranges and status ranges", async () => {
    const app = fixture({
      schema: { type: "string", pattern: "^ready$" },
      body: "ready",
      media: "text/plain; charset=utf-8",
      declaredMedia: "text/*",
      declaredStatus: "2XX",
    });
    expect(await (await app.request("/things/42")).text()).toBe("ready");
    await expect(
      fixture({
        schema: { type: "string", pattern: "^ready$" },
        body: "wrong",
        media: "text/plain",
        declaredMedia: "text/plain",
      }).request("/things/42"),
    ).rejects.toThrow("response schema mismatch");
  });

  it("checks refs, composition, formats and nested constraints with AJV", async () => {
    const app = contractApp(new OpenAPIHono());
    app.openAPIRegistry.registerComponent("schemas", "Item", {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", format: "uuid" } },
    });
    app.openAPIRegistry.registerComponent("responses", "Items", {
      description: "Items",
      content: {
        "application/json": {
          schema: {
            allOf: [
              { type: "array", items: { $ref: "#/components/schemas/Item" } },
              { minItems: 1 },
            ],
            anyOf: [{ maxItems: 2 }, { minItems: 5 }],
            oneOf: [{ maxItems: 3 }, { minItems: 4 }],
          },
        },
      },
    });
    app.openAPIRegistry.registerPath({
      method: "get",
      path: "/composed",
      responses: { default: { $ref: "#/components/responses/Items" } },
    });
    app.get("/composed", (c) =>
      c.json([{ id: c.req.query("id") ?? "0190d6a4-0000-7000-8000-000000000001" }]),
    );
    expect((await app.request("/composed")).status).toBe(200);
    await expect(app.request("/composed?id=invalid")).rejects.toThrow("response schema mismatch");
  });

  it("checks empty responses and rejects undeclared test routes", async () => {
    const app = contractApp(new OpenAPIHono());
    app.openAPIRegistry.registerPath({
      method: "delete",
      path: "/empty",
      responses: { 204: { description: "Empty" } },
    });
    app.delete("/empty", (c) => c.body(null, 204));
    app.get("/raw", (c) => c.json({}));
    expect(await (await app.request("/empty", { method: "DELETE" })).text()).toBe("");
    await expect(app.request("/raw")).rejects.toThrow("no OpenAPI operation");
  });
});
