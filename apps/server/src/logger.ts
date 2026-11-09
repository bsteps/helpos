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
  };
  return destination ? pino(config, destination) : pino(config);
}
