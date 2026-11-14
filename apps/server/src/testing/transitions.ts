type Table<S extends string> = Readonly<
  Record<string, { readonly from: readonly S[]; readonly to: S }>
>;

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
