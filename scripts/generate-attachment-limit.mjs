import { writeFileSync } from "node:fs";
import { maxAttachments, maxFilenameLength } from "../apps/server/src/inbound-email/parse.ts";

const lines = [
  "From: Attachments <attachments@customer.test>",
  "To: support@acme.test",
  "Message-ID: <attachment-limit@customer.test>",
  "Subject: Attachment limit fixture",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="attachment-limit"',
  "",
  "--attachment-limit",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Please check these logs.",
];
for (let i = 0; i <= maxAttachments; i++) {
  const filename = i === 0 ? `${"x".repeat(maxFilenameLength + 1)}.txt` : `log-${i}.txt`;
  lines.push(
    "--attachment-limit",
    "Content-Type: application/octet-stream",
    `Content-Disposition: attachment; filename="${filename}"`,
    "",
    `log ${i}`,
  );
}
lines.push("--attachment-limit--", "");
writeFileSync(
  new URL("../fixtures/email/attachment-limit.eml", import.meta.url),
  lines.join("\r\n"),
);
