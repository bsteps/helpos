import { SafeFetchError, type SafeFetchResponse } from "@helpos/safe-fetch";
import { describe, expect, it, vi } from "vitest";
import { decode, type Fetcher, fetchPageText, maxPageBytes } from "./page-fetch.ts";

const url = "https://docs.example.com/refunds";
const logger = { info: vi.fn(), warn: vi.fn() };
const latin = (text: string) => Buffer.from(text, "latin1");
const utf8 = (text: string) => Buffer.from(text, "utf8");

const cases = [
  {
    name: "quoted HTTP charset",
    type: 'text/html; charset="iso-8859-1"',
    body: latin("<p>Café crème: refunds in 5 days.</p>"),
    text: "Café crème: refunds in 5 days.",
  },
  {
    name: "unquoted HTTP charset",
    type: "text/plain; charset=iso-8859-1",
    body: latin("Café crème."),
    text: "Café crème.",
  },
  {
    name: "meta charset",
    type: "text/html",
    body: latin('<meta charset="windows-1252"><p>Crème brûlée is free.</p>'),
    text: "Crème brûlée is free.",
  },
  {
    name: "http-equiv meta charset",
    type: "text/html",
    body: latin(
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=windows-1252"><p>Crème brûlée.</p>',
    ),
    text: "Crème brûlée.",
  },
  {
    name: "undeclared Latin-1",
    type: "text/html",
    body: latin("<p>Remboursé sous 5 jours.</p>"),
    text: "Remboursé sous 5 jours.",
  },
  {
    name: "UTF-16 HTTP mislabel",
    type: "text/html; charset=utf-16",
    body: utf8("<p>Refunds in 5 days.</p>"),
    text: "Refunds in 5 days.",
  },
  {
    name: "UTF-16 meta mislabel",
    type: "text/html",
    body: utf8('<meta charset="utf-16"><p>Crème brûlée.</p>'),
    text: "Crème brûlée.",
  },
  {
    name: "real UTF-16",
    type: "text/html; charset=utf-16",
    body: Buffer.from("\ufeff<p>Real UTF-16 page.</p>", "utf16le"),
    text: "Real UTF-16 page.",
  },
  {
    name: "charset in description is not a declaration",
    type: "text/html",
    body: utf8(
      '<meta name="description" content="Set charset=iso-8859-1 here"><p>Crème brûlée.</p>',
    ),
    text: "Crème brûlée.",
  },
  {
    name: "HTTP charset precedes meta",
    type: "text/html; charset=utf-8",
    body: utf8('<meta charset="windows-1252"><p>Crème brûlée.</p>'),
    text: "Crème brûlée.",
  },
  {
    name: "unknown charset falls back to UTF-8",
    type: "text/plain; charset=unknown",
    body: utf8("Crème brûlée."),
    text: "Crème brûlée.",
  },
  {
    name: "unknown charset falls back to Windows-1252",
    type: "text/plain; charset=unknown",
    body: Buffer.from([0x80]),
    text: "€",
  },
  {
    name: "meta beyond first 1024 bytes is ignored",
    type: "text/html",
    body: utf8(`${" ".repeat(1024)}<meta charset="windows-1252"><p>Crème brûlée.</p>`),
    text: "Crème brûlée.",
  },
  {
    name: "UTF-8 BOM overrides header",
    type: "text/plain; charset=windows-1252",
    body: utf8("\ufeffCrème brûlée."),
    text: "Crème brûlée.",
  },
  {
    name: "markdown indentation",
    type: "text/markdown",
    body: utf8("# Config\n\n```yaml\nrefunds:\n  window_days: 30\n```"),
    text: "# Config\n\n```yaml\nrefunds:\n  window_days: 30\n```",
  },
];

function response(body = utf8("Refunds"), type = "text/plain", status = 200): SafeFetchResponse {
  return { url, status, headers: { "content-type": type }, body };
}

describe("fetchPageText", () => {
  it.each(cases)("$name", async ({ type, body, text }) => {
    const fetch: Fetcher = async () => response(body, type);
    expect(await fetchPageText({ fetch, logger }, url)).toEqual({ ok: true, text });
  });

  it("passes the byte limit, deadline, accepted types and logger to the fetcher", async () => {
    const fetch = vi.fn<Fetcher>().mockResolvedValue(response());
    await fetchPageText({ fetch, logger }, url);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, {
      maxBytes: maxPageBytes,
      timeoutMs: 15_000,
      headers: { accept: "text/html, text/markdown;q=0.9, text/plain;q=0.8" },
      logger,
    });
  });

  it.each([199, 300, 404, 408, 429, 500, 501, 503])(
    "returns HTTP %i without parsing the body",
    async (status) => {
      const fetch: Fetcher = async () => response(utf8("ignored"), "image/png", status);
      expect(await fetchPageText({ fetch, logger }, url)).toEqual({
        ok: false,
        error: `http_${status}`,
      });
    },
  );

  it.each(["", "image/png", "application/json"])("refuses content type %s", async (type) => {
    const fetch: Fetcher = async () => response(utf8("ignored"), type);
    expect(await fetchPageText({ fetch, logger }, url)).toEqual({
      ok: false,
      error: "unsupported_content_type",
    });
  });

  it.each(["text/plain", "text/markdown", "text/x-markdown", "text/html", "application/xhtml+xml"])(
    "accepts %s",
    async (type) => {
      const fetch: Fetcher = async () => response(utf8("Refunds"), type, 299);
      expect(await fetchPageText({ fetch, logger }, url)).toEqual({ ok: true, text: "Refunds" });
    },
  );

  it("preserves safe-fetch error codes", async () => {
    const fetch: Fetcher = async () => {
      throw new SafeFetchError("timeout", "timed out");
    };
    expect(await fetchPageText({ fetch, logger }, url)).toEqual({ ok: false, error: "timeout" });
  });

  it("propagates unexpected failures to the worker", async () => {
    const error = new Error("unexpected");
    const fetch: Fetcher = async () => {
      throw error;
    };
    await expect(fetchPageText({ fetch, logger }, url)).rejects.toBe(error);
  });
});

describe("decode", () => {
  it("reads a big-endian UTF-16 BOM before a conflicting header", () => {
    expect(decode(Buffer.from([0xfe, 0xff, 0, 0x43, 0, 0x61, 0, 0x66, 0, 0xe9]), "utf-8")).toBe(
      "Café",
    );
  });
  it("reads real UTF-16 without a BOM", () => {
    expect(decode(Buffer.from("Café", "utf16le"), "utf-16le")).toBe("Café");
  });
  it("decodes an empty page", () => {
    expect(decode(new Uint8Array(), undefined)).toBe("");
  });
});
