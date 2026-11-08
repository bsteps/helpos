import { createMemoryFileStore } from "@helpos/files";
import { createApp } from "./app.ts";

const unused = (): never => {
  throw new Error("building the API document never touches the database");
};

/** The public API contract, exactly as `GET /openapi.json` serves it, without a running server. */
export async function openApiDocument(): Promise<unknown> {
  const app = createApp({
    db: {
      ping: unused,
      withTenant: unused,
      resolveMailbox: unused,
      resolveApiToken: unused,
      listMemberships: unused,
    },
    files: createMemoryFileStore(),
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    inboundSecret: undefined,
  });
  return (await app.request("/openapi.json")).json();
}

/** The committed copy the dashboard's client is generated from. */
export const committedDocumentUrl = new URL("../../web/src/api/openapi.json", import.meta.url);

export function formatDocument(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
