import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isBlockedAddress } from "./address.ts";
import {
  createSafeFetch,
  type ResolvedAddress,
  redirectTarget,
  SafeFetchError,
  type SafeFetchOptions,
} from "./fetch.ts";

// The test server must listen on loopback, so the test policy lets exactly 127.0.0.1 through.
// Every other address still goes through the real policy.
const allowTestServer = (address: string) => address !== "127.0.0.1" && isBlockedAddress(address);

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

async function serve(handler: RequestListener): Promise<number> {
  const s = createServer(handler);
  server = s;
  await new Promise<void>((done) => s.listen(0, "127.0.0.1", done));
  return (s.address() as AddressInfo).port;
}

function rawFetcherWith(dns: Record<string, string[] | (() => string[])>) {
  return createSafeFetch({
    isBlocked: allowTestServer,
    resolve: async (hostname): Promise<ResolvedAddress[]> => {
      const entry = dns[hostname];
      if (!entry) throw new Error(`ENOTFOUND ${hostname}`);
      const list = typeof entry === "function" ? entry() : entry;
      return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
  });
}

// The test server listens on a random port, so let that port through unless a test sets its own.
function fetcherWith(dns: Record<string, string[] | (() => string[])>) {
  const fetcher = rawFetcherWith(dns);
  return (url: string, options: SafeFetchOptions = {}) => {
    const port = Number(URL.canParse(url) ? new URL(url).port : 0) || 80;
    return fetcher(url, { allowedPorts: [port, 80, 443], ...options });
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SafeFetchError) return error.code;
    throw error;
  }
  throw new Error("expected a SafeFetchError");
}

describe("safeFetch", () => {
  it("fetches a page and connects to the pinned address with the real Host header", async () => {
    let host: string | undefined;
    const port = await serve((req, res) => {
      host = req.headers.host;
      res.end("hello");
    });
    const res = await fetcherWith({ "docs.example": ["127.0.0.1"] })(
      `http://docs.example:${port}/a?b=1`,
    );
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("hello");
    expect(host).toBe(`docs.example:${port}`);
    expect(res.url).toBe(`http://docs.example:${port}/a?b=1`);
  });

  it.each([
    "http://127.0.0.2/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.2]/",
    "http://0x7f.1/", // the URL parser turns this into 127.0.0.1
    "http://2130706433/", // decimal 127.0.0.1
  ])("blocks IP literal %s with the real policy", async (url) => {
    const fetcher = createSafeFetch({ isBlocked: isBlockedAddress, resolve: async () => [] });
    expect(await codeOf(fetcher(url))).toBe("blocked_address");
  });

  it("blocks a hostname that resolves to a private address", async () => {
    expect(
      await codeOf(fetcherWith({ "evil.example": ["10.0.0.5"] })("http://evil.example/")),
    ).toBe("blocked_address");
  });

  it("blocks a mixed answer (one public, one private): a rebinding attempt", async () => {
    const fetcher = fetcherWith({ "evil.example": ["93.184.215.14", "169.254.169.254"] });
    expect(await codeOf(fetcher("http://evil.example/"))).toBe("blocked_address");
  });

  it("resolves once per hop, so a rebinding DNS answer cannot swap the address mid-request", async () => {
    const port = await serve((_req, res) => res.end("ok"));
    let calls = 0;
    // First answer is allowed, every later answer is private. One lookup per hop means the
    // connection uses the first, vetted answer and never asks again.
    const fetcher = fetcherWith({
      "rebind.example": () => (calls++ === 0 ? ["127.0.0.1"] : ["10.0.0.1"]),
    });
    const res = await fetcher(`http://rebind.example:${port}/`);
    expect(res.body.toString()).toBe("ok");
    expect(calls).toBe(1);
  });

  it("re-checks on redirect: a rebinding host is blocked on the second hop", async () => {
    let calls = 0;
    const port = await serve((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/next" });
        res.end();
      } else res.end("should not get here");
    });
    const fetcher = fetcherWith({
      "rebind.example": () => (calls++ === 0 ? ["127.0.0.1"] : ["169.254.169.254"]),
    });
    expect(await codeOf(fetcher(`http://rebind.example:${port}/start`))).toBe("blocked_address");
    expect(calls).toBe(2);
  });

  it("blocks a redirect to a private IP literal", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(301, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    const fetcher = fetcherWith({ "docs.example": ["127.0.0.1"] });
    expect(await codeOf(fetcher(`http://docs.example:${port}/`))).toBe("blocked_address");
  });

  it("follows allowed redirects and reports the final URL", async () => {
    const port = await serve((req, res) => {
      if (req.url === "/old") {
        res.writeHead(308, { location: "/new" });
        res.end();
      } else res.end("moved");
    });
    const res = await fetcherWith({ "docs.example": ["127.0.0.1"] })(
      `http://docs.example:${port}/old`,
    );
    expect(res.body.toString()).toBe("moved");
    expect(res.url).toBe(`http://docs.example:${port}/new`);
  });

  it("keeps only harmless headers on a cross-origin redirect, keeps them on the same origin", async () => {
    const seen: Record<string, string | undefined> = {};
    const port = await serve((req, res) => {
      seen[`${req.headers.host}${req.url}`] =
        `${req.headers.authorization}|${req.headers["x-api-key"]}|${req.headers.accept}`;
      if (req.url === "/start") {
        res.writeHead(302, { location: "/same" });
      } else if (req.url === "/same") {
        res.writeHead(302, { location: `http://other.example:${port}/away` });
      }
      res.end("done");
    });
    const fetcher = fetcherWith({ "docs.example": ["127.0.0.1"], "other.example": ["127.0.0.1"] });
    await fetcher(`http://docs.example:${port}/start`, {
      headers: { Authorization: "Bearer secret", "X-Api-Key": "k", Accept: "text/html" },
    });
    expect(seen[`docs.example:${port}/start`]).toBe("Bearer secret|k|text/html");
    expect(seen[`docs.example:${port}/same`]).toBe("Bearer secret|k|text/html");
    expect(seen[`other.example:${port}/away`]).toBe("undefined|undefined|text/html");
  });

  it("allows only ports 80 and 443 by default", async () => {
    const port = await serve((_req, res) => res.end("ok"));
    const fetcher = rawFetcherWith({ "docs.example": ["127.0.0.1"] });
    expect(await codeOf(fetcher(`http://docs.example:${port}/`))).toBe("blocked_port");
    expect(await codeOf(fetcher("http://docs.example:6379/"))).toBe("blocked_port");
  });

  it("checks the port on redirects too", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(302, { location: "http://docs.example:6379/" });
      res.end();
    });
    const fetcher = fetcherWith({ "docs.example": ["127.0.0.1"] });
    expect(await codeOf(fetcher(`http://docs.example:${port}/`))).toBe("blocked_port");
  });

  it("logs blocked requests with the redirect chain, origins only", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    const logger = { warn: vi.fn() };
    const fetcher = fetcherWith({ "docs.example": ["127.0.0.1"] });
    await codeOf(
      fetcher(`http://docs.example:${port}/reset/s3cret-token?token=secret`, { logger }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      {
        code: "blocked_address",
        chain: [`http://docs.example:${port}`, "http://169.254.169.254"],
      },
      "safe-fetch blocked a request",
    );
  });

  it("does not log ordinary failures as blocks", async () => {
    const logger = { warn: vi.fn() };
    await codeOf(fetcherWith({})("http://missing.example/", { logger }));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("stops after too many redirects", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(302, { location: "/loop" });
      res.end();
    });
    const fetcher = fetcherWith({ "docs.example": ["127.0.0.1"] });
    expect(await codeOf(fetcher(`http://docs.example:${port}/`, { maxRedirects: 2 }))).toBe(
      "too_many_redirects",
    );
  });

  it("rejects a redirect to a non-http protocol", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(302, { location: "file:///etc/passwd" });
      res.end();
    });
    const fetcher = fetcherWith({ "docs.example": ["127.0.0.1"] });
    expect(await codeOf(fetcher(`http://docs.example:${port}/`))).toBe("invalid_url");
  });

  it.each(["ftp://example.com/", "file:///etc/passwd", "not a url", "http://user:pw@example.com/"])(
    "rejects %s",
    async (url) => {
      expect(await codeOf(fetcherWith({})(url))).toBe("invalid_url");
    },
  );

  it("rejects a body whose Content-Length is over the limit", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { "content-length": "2000" });
      res.end("x".repeat(2000));
    });
    const fetcher = fetcherWith({ "docs.example": ["127.0.0.1"] });
    expect(await codeOf(fetcher(`http://docs.example:${port}/`, { maxBytes: 1000 }))).toBe(
      "too_large",
    );
  });

  it("rejects a streamed body that grows past the limit", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200); // chunked, no Content-Length
      for (let i = 0; i < 10; i++) res.write("x".repeat(500));
      res.end();
    });
    const fetcher = fetcherWith({ "docs.example": ["127.0.0.1"] });
    expect(await codeOf(fetcher(`http://docs.example:${port}/`, { maxBytes: 1000 }))).toBe(
      "too_large",
    );
  });

  it("times out a server that never answers", async () => {
    const port = await serve(() => {});
    const fetcher = fetcherWith({ "docs.example": ["127.0.0.1"] });
    expect(await codeOf(fetcher(`http://docs.example:${port}/`, { timeoutMs: 100 }))).toBe(
      "timeout",
    );
  });

  it("times out a slow DNS answer", async () => {
    const fetcher = createSafeFetch({
      isBlocked: isBlockedAddress,
      resolve: () => new Promise(() => {}),
    });
    expect(await codeOf(fetcher("http://slow.example/", { timeoutMs: 50 }))).toBe("timeout");
  });

  it("reports DNS failures", async () => {
    expect(await codeOf(fetcherWith({})("http://missing.example/"))).toBe("dns_failed");
  });
});

describe("redirectTarget", () => {
  const from = new URL("https://docs.example/a/b");

  it("refuses a downgrade from https to http", () => {
    expect(() => redirectTarget(from, "http://docs.example/c")).toThrow(
      expect.objectContaining({ code: "insecure_redirect" }),
    );
  });

  it("resolves relative and https targets", () => {
    expect(redirectTarget(from, "../c").href).toBe("https://docs.example/c");
    expect(redirectTarget(from, "https://other.example/").href).toBe("https://other.example/");
    expect(redirectTarget(new URL("http://docs.example/"), "https://docs.example/").protocol).toBe(
      "https:",
    );
  });
});
