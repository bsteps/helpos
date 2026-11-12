import { fileURLToPath } from "node:url";
import { oasdiff } from "./oasdiff.mjs";

await oasdiff(fileURLToPath(new URL("../", import.meta.url)), { download: true });
