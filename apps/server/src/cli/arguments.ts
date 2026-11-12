import { type ParseArgsConfig, parseArgs } from "node:util";

export interface CliOutput {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

export function parseArguments(args: string[], options: ParseArgsConfig) {
  try {
    return parseArgs({ ...options, args, strict: true, allowPositionals: false }).values;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("ERR_PARSE_ARGS_")
    )
      return null;
    throw error;
  }
}
