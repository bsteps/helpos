import type { OpenAPIHono } from "@hono/zod-openapi";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { z } from "zod";

const responseSchema = z.object({
  content: z
    .record(
      z.string(),
      z.object({ schema: z.union([z.boolean(), z.record(z.string(), z.unknown())]) }),
    )
    .optional(),
});
const documentSchema = z.object({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z.object({ schemas: z.record(z.string(), z.unknown()).optional() }).optional(),
});

export function contractApp(app: OpenAPIHono): OpenAPIHono {
  const request = app.request.bind(app);
  let previous = "";
  let ajv = new Ajv2020({ strict: false, allErrors: true });
  const validators = new Map<string, ValidateFunction>();
  app.request = async (input, init, env, executionCtx) => {
    const res = await request(input, init, env, executionCtx);
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
      "http://localhost",
    );
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const routes = app.router
      .match(method === "HEAD" ? "GET" : method, url.pathname)[0]
      .map(([[, matched]]) => matched)
      .filter((matched) => matched.method !== "ALL");
    const name = `${method} ${url.pathname} (${res.status})`;
    if (new Set(routes.map((route) => route.path)).size > 1) {
      throw new Error(`${name}: ambiguous route contracts`);
    }
    const route = routes[0];
    const rawDocument = app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "Test contract", version: "0" },
    });
    const serialized = JSON.stringify(rawDocument);
    if (serialized !== previous) {
      ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
      for (const [name, format] of Object.entries(fullFormats)) ajv.addFormat(name, format);
      validators.clear();
      previous = serialized;
    }
    const doc = documentSchema.parse(rawDocument);
    let response: z.infer<typeof responseSchema>;
    if (!route) {
      if (res.status !== 404) throw new Error(`${name}: unmatched request must return 404`);
      response = {
        content: {
          "application/problem+json": {
            schema: {
              $ref: "#/components/schemas/Error",
              allOf: [
                {
                  type: "object",
                  required: ["type", "title", "status", "instance"],
                  properties: {
                    type: { const: "about:blank" },
                    title: { type: "string" },
                    status: { const: 404 },
                    instance: { type: "string" },
                  },
                },
              ],
            },
          },
        },
      };
    } else if (route.path === "/openapi.json" && method === "GET") {
      response = {
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["openapi", "info", "paths"],
              properties: {
                openapi: { const: "3.1.0" },
                paths: { type: "object" },
                info: { type: "object" },
              },
            },
          },
        },
      };
    } else {
      const path = route.path.replace(/:([^/]+)/g, "{$1}");
      const operation = z
        .object({ responses: z.record(z.string(), z.unknown()) })
        .safeParse(doc.paths[path]?.[method.toLowerCase()]);
      if (!operation.success)
        throw new Error(
          `${name}: ${route.path} has no OpenAPI operation; declare test routes with openapi()`,
        );
      const responses = operation.data.responses;
      const status = String(res.status);
      const key =
        status in responses ? status : `${status[0]}XX` in responses ? `${status[0]}XX` : "default";
      let declared = responses[key];
      const references = new Set<string>();
      while (declared && typeof declared === "object" && "$ref" in declared) {
        const ref = z.string().parse(declared.$ref);
        if (!ref.startsWith("#/"))
          throw new Error(`${name}: external response refs are unsupported`);
        if (references.has(ref)) throw new Error(`${name}: cyclic response ref ${ref}`);
        references.add(ref);
        declared = ref
          .slice(2)
          .split("/")
          .reduce<unknown>(
            (value, part) =>
              z.record(z.string(), z.unknown()).parse(value)[
                part.replaceAll("~1", "/").replaceAll("~0", "~")
              ],
            rawDocument,
          );
      }
      if (!declared) throw new Error(`${name}: undeclared response status on ${path}`);
      response = responseSchema.parse(declared);
    }
    const text = await res.clone().text();
    if (method === "HEAD" || res.status === 204 || res.status === 304 || !response.content) {
      if (text !== "") throw new Error(`${name}: expected an empty response body`);
      return res;
    }
    const media = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const content = response.content;
    const declaredMedia =
      media &&
      (content[media]
        ? media
        : content[`${media.split("/")[0]}/*`]
          ? `${media.split("/")[0]}/*`
          : "*/*");
    if (!declaredMedia || !content[declaredMedia])
      throw new Error(`${name}: undeclared response media type ${media ?? "<missing>"}`);
    const schema = content[declaredMedia].schema;
    const cacheKey = JSON.stringify(schema);
    let validate = validators.get(cacheKey);
    if (!validate) {
      validate = ajv.compile({ components: rawDocument.components ?? {}, allOf: [schema] });
      validators.set(cacheKey, validate);
    }
    const body: unknown =
      media === "application/json" || media?.endsWith("+json") ? JSON.parse(text) : text;
    if (!validate(body))
      throw new Error(`${name}: response schema mismatch ${ajv.errorsText(validate.errors)}`);
    return res;
  };
  return app;
}
