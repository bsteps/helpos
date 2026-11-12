import { createDatabase, createJobRunner } from "@helpos/db";
import { createMemoryFileStore } from "@helpos/files";
import { z } from "zod";
import { createSmtpTransport } from "../../outbound-email/transport.ts";
import { sendReplyJob } from "../jobs.ts";
import { handleSendGaveUp, handleSendReply } from "../send-worker.ts";

const config = z
  .object({ TEST_APP_URL: z.string(), TEST_JOBS_URL: z.string(), TEST_SMTP_URL: z.string() })
  .parse(process.env);
const db = createDatabase(config.TEST_APP_URL);
const smtp = createSmtpTransport(config.TEST_SMTP_URL);
const runner = createJobRunner({
  db,
  jobsUrl: config.TEST_JOBS_URL,
  pollingIntervalSeconds: 0.5,
  onError: () => {},
});
await runner.start();
await runner.work(sendReplyJob, {
  steps: handleSendReply({
    files: createMemoryFileStore(),
    logger: { info: () => {}, warn: () => {} },
    transport: {
      send: async (mail) => {
        await smtp.send(mail);
        process.send?.("SMTP accepted");
        await new Promise<void>(() => {});
      },
      close: () => smtp.close(),
    },
  }),
  onGiveUp: handleSendGaveUp,
});
