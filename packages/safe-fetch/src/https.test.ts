import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { afterEach, expect, it, vi } from "vitest";
import { isBlockedAddress } from "./address.ts";
import { createSafeFetch, safeFetch } from "./index.ts";

const cert = readFileSync(new URL("./fixtures/https-test-cert.pem", import.meta.url));
const key = readFileSync(new URL("./fixtures/https-test-key.pem", import.meta.url));
const request = https.request;
let server: https.Server | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  const current = server;
  server = undefined;
  if (current) {
    current.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      current.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function serve() {
  const received: { host: string | undefined; servername: string | false }[] = [];
  const current = https.createServer({ cert, key }, (req, res) => {
    received.push({
      host: req.headers.host,
      servername: "servername" in req.socket ? String(req.socket.servername) : false,
    });
    res.end("pinned HTTPS response");
  });
  server = current;
  await new Promise<void>((resolve) => current.listen(0, "127.0.0.1", resolve));
  const address = current.address();
  if (!address || typeof address === "string") throw new Error("expected TCP listener");
  const resolve = vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]);
  const isBlocked = vi.fn((ip: string) => ip !== "127.0.0.1" && isBlockedAddress(ip));
  return {
    port: address.port,
    received,
    resolve,
    isBlocked,
    fetch: createSafeFetch({ resolve, isBlocked }),
  };
}

function trustFixture() {
  vi.spyOn(https, "request").mockImplementation(
    (
      options: https.RequestOptions | string | URL,
      callback?: https.RequestOptions | ((res: IncomingMessage) => void),
    ) => {
      if (typeof options === "string" || options instanceof URL || typeof callback !== "function") {
        throw new Error("expected request options and response callback");
      }
      return request({ ...options, ca: cert }, callback);
    },
  );
}

it("refuses a self-signed certificate by default after connecting to the checked IP", async () => {
  const local = await serve();
  await expect(
    local.fetch(`https://docs.test:${local.port}/`, { allowedPorts: [local.port] }),
  ).rejects.toMatchObject({
    code: "network",
    cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
  });
  expect(local.resolve).toHaveBeenCalledExactlyOnceWith("docs.test");
  expect(local.isBlocked).toHaveBeenCalledExactlyOnceWith("127.0.0.1");
  expect(local.received).toEqual([]);
});

it("uses the checked IP while retaining the HTTPS hostname and SNI", async () => {
  const local = await serve();
  trustFixture();
  const response = await local.fetch(`https://docs.test:${local.port}/`, {
    allowedPorts: [local.port],
  });
  expect(response.status).toBe(200);
  expect(response.body.toString()).toBe("pinned HTTPS response");
  expect(local.received).toEqual([{ host: `docs.test:${local.port}`, servername: "docs.test" }]);
  expect(local.resolve).toHaveBeenCalledExactlyOnceWith("docs.test");
  expect(local.isBlocked).toHaveBeenCalledExactlyOnceWith("127.0.0.1");
});

it("rejects a trusted certificate for a different hostname at the same checked IP", async () => {
  const local = await serve();
  trustFixture();
  await expect(
    local.fetch(`https://other.test:${local.port}/`, { allowedPorts: [local.port] }),
  ).rejects.toMatchObject({
    code: "network",
    cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
  });
  expect(local.received).toEqual([]);
});

it("refuses localhost through the default real resolver and address policy", async () => {
  await expect(safeFetch("https://localhost/")).rejects.toMatchObject({ code: "blocked_address" });
});
