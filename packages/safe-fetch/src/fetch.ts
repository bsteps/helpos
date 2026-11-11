import { lookup } from "node:dns/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { brand } from "@helpos/brand";
import { isBlockedAddress } from "./address.ts";

export type SafeFetchErrorCode =
  | "invalid_url"
  | "blocked_address"
  | "blocked_port"
  | "insecure_redirect"
  | "dns_failed"
  | "timeout"
  | "aborted"
  | "too_large"
  | "too_many_redirects"
  | "network";

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  constructor(code: SafeFetchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

export interface SafeFetchOptions {
  /** Whole request, all redirects included. Default 10 s. */
  timeoutMs?: number;
  /** Largest body accepted. Default 5 MiB. */
  maxBytes?: number;
  /** Default 5. */
  maxRedirects?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Ports that may be reached, on the first URL and on every redirect. Default 80 and 443. */
  allowedPorts?: readonly number[];
  /** Gets a warning for every blocked request, so SSRF probes are visible. Pino-compatible. */
  logger?: SafeFetchLogger;
}

interface SafeFetchLogger {
  warn: (details: object, message: string) => void;
}

export interface SafeFetchResponse {
  /** The URL that answered, after redirects. */
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeFetchDeps {
  resolve: (hostname: string) => Promise<ResolvedAddress[]>;
  isBlocked: (address: string) => boolean;
}

const defaultDeps: SafeFetchDeps = {
  resolve: async (hostname) => {
    const results = await lookup(hostname, { all: true, verbatim: true });
    return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
  },
  isBlocked: isBlockedAddress,
};

function parseUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch (cause) {
    throw new SafeFetchError("invalid_url", "not a valid URL", { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("invalid_url", `protocol ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) {
    throw new SafeFetchError("invalid_url", "credentials in URLs are not allowed");
  }
  return url;
}

/** Where a redirect leads, refusing targets that would weaken the request. */
export function redirectTarget(current: URL, location: string): URL {
  const next = parseUrl(location, current);
  if (current.protocol === "https:" && next.protocol === "http:") {
    throw new SafeFetchError("insecure_redirect", "redirect from https to http");
  }
  return next;
}

const blockCodes = new Set<SafeFetchErrorCode>([
  "blocked_address",
  "blocked_port",
  "insecure_redirect",
]);

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export function createSafeFetch(deps: SafeFetchDeps = defaultDeps) {
  /** Resolves once and vets every address, so the one we then connect to cannot be swapped. */
  async function pinAddress(hostname: string): Promise<ResolvedAddress> {
    const bare = hostname.replace(/^\[|\]$/g, "");
    const literal = isIP(bare);
    let addresses: ResolvedAddress[];
    if (literal !== 0) {
      addresses = [{ address: bare, family: literal === 6 ? 6 : 4 }];
    } else {
      try {
        addresses = await deps.resolve(bare);
      } catch (cause) {
        throw new SafeFetchError("dns_failed", `could not resolve ${bare}`, { cause });
      }
    }
    const first = addresses[0];
    if (!first) throw new SafeFetchError("dns_failed", `no addresses for ${bare}`);
    // Any private answer rejects the host: a mixed answer is a rebinding attempt.
    for (const a of addresses) {
      if (deps.isBlocked(a.address)) {
        throw new SafeFetchError("blocked_address", `${bare} resolves to a blocked address`);
      }
    }
    return first;
  }

  function requestOnce(
    url: URL,
    pinned: ResolvedAddress,
    options: Required<Pick<SafeFetchOptions, "maxBytes">> & SafeFetchOptions,
    signal: AbortSignal,
  ): Promise<SafeFetchResponse> {
    // Node's connect calls this instead of DNS, so it can only reach the vetted address.
    const pinnedLookup: LookupFunction = (_host, opts, callback) => {
      if (opts.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    };
    const isHttps = url.protocol === "https:";
    const hostname = url.hostname.replace(/^\[|\]$/g, "");

    return new Promise((resolve, reject) => {
      const req = (isHttps ? https : http).request(
        {
          protocol: url.protocol,
          hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: options.headers,
          lookup: pinnedLookup,
          // TLS still verifies the certificate against the real hostname.
          servername: isHttps && isIP(hostname) === 0 ? hostname : undefined,
          agent: false,
          signal,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > options.maxBytes) {
            res.destroy();
            reject(new SafeFetchError("too_large", `body is ${declared} bytes`));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > options.maxBytes) {
              res.destroy();
              reject(new SafeFetchError("too_large", `body exceeds ${options.maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            resolve({ url: url.href, status, headers: res.headers, body: Buffer.concat(chunks) });
          });
          res.on("error", (cause) => reject(toError(cause, signal)));
        },
      );
      req.on("error", (cause) => reject(toError(cause, signal)));
      req.end();
    });
  }

  return async function safeFetch(
    rawUrl: string,
    options: SafeFetchOptions = {},
  ): Promise<SafeFetchResponse> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    const maxRedirects = options.maxRedirects ?? 5;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

    const allowedPorts = options.allowedPorts ?? [80, 443];
    let url = parseUrl(rawUrl);
    let headers = withDefaultUserAgent(options.headers ?? {});
    // Origins only: paths and query strings can carry tokens and must not reach the logs.
    const chain: string[] = [];
    try {
      for (let hop = 0; ; hop++) {
        chain.push(url.origin);
        const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
        // Internal services (Redis, SMTP, memcached) often sit on public hosts too.
        if (!allowedPorts.includes(port)) {
          throw new SafeFetchError("blocked_port", `port ${port} is not allowed`);
        }
        const pinned = await raceAbort(pinAddress(url.hostname), signal);
        const res = await requestOnce(url, pinned, { ...options, headers, maxBytes }, signal);
        const location = res.headers.location;
        if (!redirectStatuses.has(res.status) || !location) return res;
        if (hop >= maxRedirects) {
          throw new SafeFetchError("too_many_redirects", `more than ${maxRedirects} redirects`);
        }
        const next = redirectTarget(url, location);
        // A redirect must not carry the caller's credentials to another site.
        if (next.origin !== url.origin) headers = onlySafeHeaders(headers);
        url = next;
      }
    } catch (error) {
      if (error instanceof SafeFetchError && blockCodes.has(error.code)) {
        options.logger?.warn({ code: error.code, chain }, "safe-fetch blocked a request");
      }
      throw error;
    }
  };
}

// Custom headers often carry secrets (API keys under any name), so another site only gets
// headers known to be harmless.
const crossOriginSafeHeaders = new Set(["accept", "accept-language", "user-agent"]);

// Some sites and WAFs reject requests that send no User-Agent at all.
export const defaultUserAgent = `${brand.name}-Fetch/1.0 (+${brand.repositoryUrl})`;

function withDefaultUserAgent(headers: Record<string, string>): Record<string, string> {
  const hasOwn = Object.keys(headers).some((name) => name.toLowerCase() === "user-agent");
  return hasOwn ? headers : { ...headers, "user-agent": defaultUserAgent };
}

function onlySafeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => crossOriginSafeHeaders.has(name.toLowerCase())),
  );
}

function toError(cause: unknown, signal: AbortSignal): SafeFetchError {
  if (signal.aborted) {
    // AbortSignal.any keeps the reason of whichever signal fired, so ours reads as TimeoutError.
    const timedOut = signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
    return timedOut
      ? new SafeFetchError("timeout", "request timed out", { cause })
      : new SafeFetchError("aborted", "request was aborted by the caller", { cause });
  }
  return new SafeFetchError("network", "request failed", { cause });
}

/** DNS lookups ignore abort signals, so the deadline has to cover them separately. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(toError(signal.reason, signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(toError(signal.reason, signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export const safeFetch = createSafeFetch();
