import type { schema } from "@helpos/db";
import { SafeFetchError, type SafeFetchLogger, type safeFetch } from "@helpos/safe-fetch";
import { Parser } from "htmlparser2";
import { extractHtml, tidyAuthored } from "./extract.ts";

/** The SSRF-safe fetch. A parameter only so tests can reach a local test server. */
export type Fetcher = typeof safeFetch;

export const maxPageBytes = 2 * 1024 * 1024;
const fetchTimeoutMs = 15_000;

export type PageText =
  | { ok: true; text: string }
  | { ok: false; reason: schema.KnowledgeFailureReason };

const htmlTypes = new Set(["text/html", "application/xhtml+xml"]);
const textTypes = new Set(["text/plain", "text/markdown", "text/x-markdown"]);

/**
 * The charset a page declares in `<meta charset>` or `<meta http-equiv content>`, looked for
 * in its first 1024 bytes as browsers do. Bounded, so a huge page costs nothing extra.
 */
function metaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  let label: string | undefined;
  // Parsed, not searched: "charset=" in another tag's text (a description) declares nothing.
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (label || name !== "meta") return;
        if (attribs.charset) label = attribs.charset.trim();
        else if (attribs["http-equiv"]?.trim().toLowerCase() === "content-type") {
          label = /charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(attribs.content ?? "")?.[1];
        }
      },
    },
    { lowerCaseTags: true, lowerCaseAttributeNames: true, decodeEntities: true },
  );
  parser.write(head);
  parser.end();
  // A page readable as ASCII so far can't really be UTF-16; browsers read it as UTF-8.
  return label && /^utf-16/i.test(label) ? "utf-8" : label || undefined;
}

/** Fetches one page through the SSRF-safe fetch and returns its text, or why it couldn't. */
export async function fetchPageText(
  deps: { fetch: Fetcher; logger: SafeFetchLogger },
  url: string,
): Promise<PageText> {
  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await deps.fetch(url, {
      maxBytes: maxPageBytes,
      timeoutMs: fetchTimeoutMs,
      headers: { accept: "text/html, text/markdown;q=0.9, text/plain;q=0.8" },
      logger: deps.logger,
    });
  } catch (error) {
    if (error instanceof SafeFetchError) return { ok: false, reason: { code: error.code } };
    throw error;
  }
  if (res.status < 200 || res.status > 299)
    return { ok: false, reason: { code: "http_error", status: res.status } };

  const [mediaType = "", ...params] = String(res.headers["content-type"] ?? "")
    .toLowerCase()
    .split(";")
    .map((p) => p.trim());
  const isHtml = htmlTypes.has(mediaType);
  if (!isHtml && !textTypes.has(mediaType))
    return { ok: false, reason: { code: "unsupported_content_type" } };

  // `charset="iso-8859-1"` is valid too: the quotes aren't part of the label. Without one in
  // the header, a page can still say it in a <meta> tag.
  const declared =
    params
      .find((p) => p.startsWith("charset="))
      ?.slice(8)
      .replaceAll(/^["']|["']$/g, "")
      .trim() || (isHtml ? metaCharset(res.body) : undefined);
  const body = decode(res.body, declared);
  return { ok: true, text: isHtml ? extractHtml(body).text : tidyAuthored(body) };
}

/**
 * Bytes to text in the declared charset. Undeclared (or unknown): UTF-8 when the bytes are
 * valid UTF-8, as nearly all pages are, else windows-1252, the old web's default.
 */
export function decode(bytes: Uint8Array, declared: string | undefined): string {
  // A byte order mark settles it, whatever the page or the server says.
  const bom =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? "utf-8"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : bytes[0] === 0xff && bytes[1] === 0xfe
          ? "utf-16le"
          : undefined;
  // UTF-16 text has a zero byte in nearly every Latin character. A "utf-16" label on bytes
  // without one is a misconfigured server, and reading it as UTF-16 would make it nonsense.
  const misread =
    !bom && declared && /^utf-16/i.test(declared) && !bytes.subarray(0, 1024).includes(0);
  const charset = bom ?? (misread ? undefined : declared);
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return decodeUndeclared(bytes);
    }
  }
  return decodeUndeclared(bytes);
}

function decodeUndeclared(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
