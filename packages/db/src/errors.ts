/** True for a Postgres unique-constraint violation (SQLSTATE 23505), optionally on one constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  // Drizzle wraps driver errors, so look at the cause too.
  for (let e: unknown = error, depth = 0; e && depth < 3; depth++) {
    if (typeof e === "object" && "code" in e && e.code === "23505") {
      return (
        constraint === undefined || ("constraint_name" in e && e.constraint_name === constraint)
      );
    }
    e = typeof e === "object" && "cause" in e ? e.cause : undefined;
  }
  return false;
}
