/** True for a Postgres unique-constraint violation (SQLSTATE 23505), optionally on one constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = driverError(error);
  return e?.code === "23505" && (constraint === undefined || e.constraint === constraint);
}

/** The SQLSTATE of a failed query, such as `42501` for a missing privilege. */
export function sqlState(error: unknown): string | undefined {
  return driverError(error)?.code;
}

// Drizzle wraps driver errors, so look at the cause too.
function driverError(error: unknown): { code: string; constraint: unknown } | undefined {
  for (let e: unknown = error, depth = 0; e && depth < 3; depth++) {
    if (typeof e === "object" && "code" in e && typeof e.code === "string") {
      return { code: e.code, constraint: "constraint_name" in e ? e.constraint_name : undefined };
    }
    e = typeof e === "object" && "cause" in e ? e.cause : undefined;
  }
  return undefined;
}
