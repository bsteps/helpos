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
    // Every error under `err` or `error` is logged as its summary, never its message:
    // `logger.error({ err }, …)` is safe wherever it's written. An error nested deeper is not.
    serializers: { err: errorSummary, error: errorSummary },
    hooks: {
      // With no message given, pino uses the error's own message as the log line.
      logMethod(args, method) {
        const [first, second] = args;
        const carriesError =
          first instanceof Error ||
          (typeof first === "object" && first !== null && ("err" in first || "error" in first));
        if (carriesError && typeof second !== "string") {
          return method.apply(this, [first, "error", ...args.slice(1)]);
        }
        return method.apply(this, args);
      },
    },
  };
  return destination ? pino(config, destination) : pino(config);
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
