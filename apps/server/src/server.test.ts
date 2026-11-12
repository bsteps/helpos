import { once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import * as database from "@helpos/db";
import { createMemoryFileStore } from "@helpos/files";
import { afterEach, expect, it, vi } from "vitest";
import { createLogger } from "./logger.ts";
import { composeServer } from "./server.ts";

const unused = (): never => {
  throw new Error("unexpected database or worker access");
};

afterEach(() => vi.restoreAllMocks());

it.each(["default", "custom"] as const)(
  "%s job error callback drops a completed request's context on a real socket error",
  async (handler) => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info" }, { write: (line) => lines.push(line) });
    const accepted = Promise.withResolvers<Socket>();
    const reported = Promise.withResolvers<Error>();
    const sockets = new Set<Socket>();
    const loopback = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      accepted.resolve(socket);
    });
    let reportRunnerError: (error: unknown) => void = unused;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      loopback.listen(0, "127.0.0.1");
      await once(loopback, "listening", { signal: AbortSignal.timeout(5000) });
      const address = loopback.address();
      if (!address || typeof address === "string") throw new Error("no loopback TCP port");
      vi.spyOn(database, "createJobRunner").mockImplementation((options) => {
        reportRunnerError = options.onError;
        return {
          start: unused,
          stop: unused,
          ensureQueue: unused,
          work: unused,
          ready: async () => {
            logger.info("queue readiness probe");
            const client = connect({ host: "127.0.0.1", port: address.port });
            sockets.add(client);
            client.on("error", (error) => {
              reportRunnerError(error);
              reported.resolve(error);
            });
            await once(client, "connect", { signal: AbortSignal.timeout(5000) });
            return { ok: true };
          },
        };
      });
      const server = composeServer({
        db: {
          ping: async () => {
            logger.info("database readiness probe");
            return { ok: true };
          },
          withTenant: unused,
          resolveMailbox: unused,
          resolveApiToken: unused,
          listMemberships: unused,
          close: unused,
        },
        files: createMemoryFileStore(),
        logger,
        jobsUrl: "postgres://unused.invalid/test",
        ...(handler === "custom"
          ? {
              onJobError: (error: unknown) =>
                logger.error({ err: error, token: "private-token" }, "custom job runner error"),
            }
          : {}),
      });
      const app = server.app();
      logger.info("outside request: before");
      const ready = await app.request("/readyz", {
        headers: { "x-request-id": "finished-readiness-request" },
      });
      expect(ready.status).toBe(200);
      expect(ready.headers.get("x-request-id")).toBe("finished-readiness-request");
      logger.info("outside request: after");
      const health = await app.request("/health", {
        headers: { "x-request-id": "health-request" },
      });
      expect(health.status).toBe(200);
      const peer = await accepted.promise;
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("no loopback socket reset")), 5000);
      });
      peer.resetAndDestroy();
      expect(await Promise.race([reported.promise, timeout])).toMatchObject({ code: "ECONNRESET" });
      const entries = lines.map((line) => JSON.parse(line));
      expect(entries).toEqual([
        expect.not.objectContaining({ requestId: expect.anything() }),
        expect.objectContaining({
          msg: "database readiness probe",
          requestId: "finished-readiness-request",
        }),
        expect.objectContaining({
          msg: "queue readiness probe",
          requestId: "finished-readiness-request",
        }),
        expect.objectContaining({
          msg: "request completed",
          path: "/readyz",
          requestId: "finished-readiness-request",
        }),
        expect.not.objectContaining({ requestId: expect.anything() }),
        expect.objectContaining({
          msg: "request completed",
          path: "/health",
          requestId: "health-request",
        }),
        expect.objectContaining({
          msg: handler === "custom" ? "custom job runner error" : "job runner error",
          err: expect.objectContaining({ code: "ECONNRESET" }),
        }),
      ]);
      expect(entries.at(-1)).not.toHaveProperty("requestId");
      expect(lines.join("")).not.toContain("private-token");
      expect(lines.join("")).not.toContain("read ECONNRESET");
    } finally {
      clearTimeout(deadline);
      for (const socket of sockets) socket.destroy();
      if (loopback.listening) {
        await new Promise<void>((resolve, reject) => {
          loopback.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  },
);
