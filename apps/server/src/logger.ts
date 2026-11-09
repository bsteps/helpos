import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

/**
 * Fields that hold credentials. Our code never logs them on purpose; this catches the one
 * that slips in by accident (a request object, an options bag), at the top level or one level
 * down, where pino's wildcard reaches.
 */
const redactedPaths = [
  "token",
  "githubToken",
  "webhookSecret",
  "secret",
  "password",
  "authorization",
  "headers.authorization",
  "*.token",
  "*.githubToken",
  "*.webhookSecret",
  "*.secret",
  "*.password",
  "*.authorization",
  "*.headers.authorization",
];

export function createLogger(
  options: Pick<LoggerOptions, "level" | "base">,
  destination?: DestinationStream,
): Logger {
  const config: LoggerOptions = {
    ...options,
    redact: { paths: redactedPaths, censor: "[redacted]" },
    // Every error is logged as its summary, never its message: `logger.error({ err }, …)` is
    // safe wherever it's written. `err` and `error` go through these; the hook below covers an
    // error anywhere else in the entry.
    serializers: { err: errorSummary, error: errorSummary },
    hooks: {
      // With no message given, pino uses the error's own message as the log line.
      logMethod(args, method) {
        const [first, ...rest] = args;
        const carriesError =
          first instanceof Error ||
          (typeof first === "object" && first !== null && ("err" in first || "error" in first));
        // Same shape as `args`: only errors are swapped for their summaries.
        const safe = [
          isPlainObject(first) ? summariseNestedErrors(first) : first,
          ...rest.map((arg) => (arg instanceof Error ? errorSummary(arg) : arg)),
        ] as typeof args;
        if (carriesError && typeof rest[0] !== "string") {
          return method.apply(this, [safe[0], "error", ...safe.slice(1)]);
        }
        return method.apply(this, safe);
      },
    },
  };
  return destination ? pino(config, destination) : pino(config);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** How deep to look for errors. Deep enough for any entry we write, and it stops cycles. */
const errorSearchDepth = 6;

/**
 * A copy of a log entry with every error inside it replaced by its summary. `err` and
 * `error` at the top are left to their serializers. Only plain objects and arrays are copied.
 */
function summariseNestedErrors(entry: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown, depth: number): unknown => {
    if (value instanceof Error) return errorSummary(value);
    if (depth === 0) return value;
    if (Array.isArray(value)) return value.map((v) => walk(v, depth - 1));
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, depth - 1)]));
  };
  return Object.fromEntries(
    Object.entries(entry).map(([k, v]) => [
      k,
      k === "err" || k === "error" ? v : walk(v, errorSearchDepth),
    ]),
  );
}

/**
 * The frames after the message. The message (which may span lines and contain anything) is
 * cut off by position, not recognised by content. If the stack doesn't start with it, as
 * V8 normally does, nothing is returned rather than risk logging it.
 */
function stackFrames(err: Error): string | undefined {
  const header = `${err.name}: ${err.message}\n`;
  if (!err.stack?.startsWith(header)) return undefined;
  return err.stack.slice(header.length).split("\n").slice(0, 5).join("\n");
}

/**
 * What is safe to log about an unexpected error. Drizzle query errors carry the SQL
 * parameters (email bodies, addresses) in their message, so those are never logged; only the
 * error type, the Postgres SQLSTATE and constraint name, and the stack frames.
 */
export function errorSummary(err: unknown): Record<string, unknown> {
  const cause = err instanceof Error ? err.cause : undefined;
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null;
  // `throw null` is legal JS: the error handler must never crash on it.
  const pg = isObject(cause) ? cause : isObject(err) ? err : {};
  return {
    name: err instanceof Error ? err.name : typeof err,
    code: typeof pg.code === "string" ? pg.code : undefined,
    constraint: typeof pg.constraint_name === "string" ? pg.constraint_name : undefined,
    stack: err instanceof Error ? stackFrames(err) : undefined,
  };
}
