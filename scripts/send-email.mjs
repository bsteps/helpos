// `pnpm dev:send-email <fixture.eml>`: posts a raw email to the local inbound endpoint, the
// same way an email provider would. Reads HELPOS_PORT and HELPOS_INBOUND_SECRET from .env.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  process.stderr.write("Usage: pnpm dev:send-email <file.eml>   (e.g. fixtures/email/plain.eml)\n");
  process.exit(2);
}

// Not a Turborepo task, so these env vars are deliberately not declared in turbo.json.
const { HELPOS_INBOUND_SECRET: secret, HELPOS_PORT: port = "3000" } = process.env;
if (!secret) {
  process.stderr.write("HELPOS_INBOUND_SECRET is not set. Add it to .env (see .env.example).\n");
  process.exit(2);
}

const res = await fetch(`http://localhost:${port}/v1/inbound/email`, {
  method: "POST",
  headers: { authorization: `Bearer ${secret}`, "content-type": "message/rfc822" },
  body: readFileSync(file),
});
process.stdout.write(`${res.status} ${await res.text()}\n`);
process.exit(res.ok ? 0 : 1);
