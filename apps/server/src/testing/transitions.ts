import fc from "fast-check";

type Table<S extends string> = Readonly<
  Record<string, { readonly from: readonly S[]; readonly to: S }>
>;

export interface Step<S extends string> {
  operation: string;
  before: S;
  after: S;
}

/** Every status change the table allows, as "from → to (operation)". */
export function edges<S extends string>(table: Table<S>): string[] {
  return Object.entries(table)
    .flatMap(([operation, t]) => t.from.map((from) => `${from} → ${t.to} (${operation})`))
    .sort();
}

export function reachable<S extends string>(table: Table<S>, start: S): S[] {
  const reached = new Set<S>([start]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of Object.values(table)) {
      if (t.from.some((s) => reached.has(s)) && !reached.has(t.to)) {
        reached.add(t.to);
        grew = true;
      }
    }
  }
  return [...reached].sort();
}

/**
 * Random sequences of operations from `start`. An operation whose `from` doesn't hold changes
 * nothing, as the lifecycle's guarded write does.
 */
export function walks<S extends string>(table: Table<S>, start: S): fc.Arbitrary<Step<S>[]> {
  return fc.array(fc.constantFrom(...Object.keys(table)), { maxLength: 40 }).map((operations) => {
    let status = start;
    return operations.map((operation) => {
      const t = table[operation];
      const before = status;
      if (t?.from.includes(status)) status = t.to;
      return { operation, before, after: status };
    });
  });
}
