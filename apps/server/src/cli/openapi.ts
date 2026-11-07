// `pnpm --filter @helpos/server openapi`: writes the API contract to apps/web/src/api/openapi.json,
// which the dashboard's typed client is generated from (`pnpm --filter @helpos/web gen:api`).
import { writeFileSync } from "node:fs";
import { committedDocumentUrl, formatDocument, openApiDocument } from "../openapi.ts";

writeFileSync(committedDocumentUrl, formatDocument(await openApiDocument()));
