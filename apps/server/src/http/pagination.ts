import { z } from "@hono/zod-openapi";

const positionSchema = z.object({ id: z.uuid(), createdAt: z.iso.datetime() });

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .max(512)
    .transform((value, ctx) => {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid cursor encoding");
        const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
        return positionSchema.parse(decoded);
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid cursor" });
        return z.NEVER;
      }
    })
    .optional(),
});

/** Pass limit + 1 rows, ordered by createdAt and id descending. */
export function cursorPage<T extends { id: string; createdAt: Date }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? Buffer.from(
          JSON.stringify({ id: last.id, createdAt: last.createdAt.toISOString() }),
        ).toString("base64url")
      : null;
  return { items, nextCursor };
}
