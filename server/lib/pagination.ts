import { z } from "zod";
import { and, eq, lt, or, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Keyset (cursor) pagination.
 *
 * Offset pagination double-renders rows in a live transcript: a channel that
 * appends while you scroll shifts every row's offset, so page N+1 repeats
 * items you already saw (and drops others). Keyset paging anchors on the last
 * row you actually received instead.
 *
 * The cursor is `<createdAt ISO>,<id>` — createdAt is not unique on its own
 * (two messages can land in the same millisecond), so the row id is the
 * tiebreaker. Lists are ordered newest-first and `before` walks backwards
 * into history.
 */

export const CURSOR_SEPARATOR = ",";

export interface Cursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(row: { createdAt: Date | string | number; id: string }): string {
  const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
  return `${createdAt.toISOString()}${CURSOR_SEPARATOR}${row.id}`;
}

/** Parse a cursor. Returns null for anything malformed — never throws. */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  const idx = raw.indexOf(CURSOR_SEPARATOR);
  if (idx <= 0) return null;

  const id = raw.slice(idx + 1);
  if (!id) return null;

  const createdAt = new Date(raw.slice(0, idx));
  if (Number.isNaN(createdAt.getTime())) return null;

  return { createdAt, id };
}

export const keysetQuery = z.object({
  /** Opaque cursor: return rows strictly older than this one. */
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type KeysetQuery = z.infer<typeof keysetQuery>;

export interface KeysetPage<T> {
  data: T[];
  /** Pass back as `before` to fetch the next (older) page. */
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Build the `WHERE` half of a keyset query against a newest-first ordering:
 *
 *   createdAt < cursor.createdAt OR (createdAt = cursor.createdAt AND id < cursor.id)
 *
 * Pair with `.orderBy(desc(createdAt), desc(id)).limit(limit + 1)` and hand
 * the rows to {@link keysetPage}. Returns undefined for a null cursor so it
 * composes with `and(...filters)` unchanged.
 */
export function keysetBefore(
  columns: { createdAt: SQLWrapper; id: SQLWrapper },
  cursor: Cursor | null,
): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(columns.createdAt, cursor.createdAt),
    and(eq(columns.createdAt, cursor.createdAt), lt(columns.id, cursor.id)),
  );
}

/**
 * Turn `limit + 1` fetched rows into a page. Fetching one extra row is how
 * `hasMore` is known without a second COUNT query — which is the other thing
 * offset pagination made expensive.
 */
export function keysetPage<T extends { createdAt: Date | string | number; id: string }>(
  rows: T[],
  limit: number,
): KeysetPage<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return {
    data,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    hasMore,
  };
}

/**
 * In-memory keyset paging, for lists that do not come from SQL (e.g. the
 * Docker container list). Input must already be sorted newest-first.
 */
export function paginateKeyset<T extends { createdAt: Date | string | number; id: string }>(
  items: T[],
  query: { before?: string | null; limit?: number },
): KeysetPage<T> {
  const limit = query.limit ?? 50;
  const cursor = decodeCursor(query.before);

  let start = 0;
  if (cursor) {
    const at = items.findIndex((item) => {
      const created = item.createdAt instanceof Date ? item.createdAt : new Date(item.createdAt);
      return created.getTime() === cursor.createdAt.getTime() && item.id === cursor.id;
    });
    if (at >= 0) {
      start = at + 1;
    } else {
      // Cursor row is gone (deleted/rotated). Fall back to a value compare so
      // the client still advances instead of restarting at the top.
      start = items.findIndex((item) => {
        const created = item.createdAt instanceof Date ? item.createdAt : new Date(item.createdAt);
        return (
          created.getTime() < cursor.createdAt.getTime() ||
          (created.getTime() === cursor.createdAt.getTime() && item.id < cursor.id)
        );
      });
      if (start < 0) start = items.length;
    }
  }

  return keysetPage(items.slice(start, start + limit + 1), limit);
}

// ---------------------------------------------------------------------------
// DEPRECATED — offset pagination (landmine 5)
// ---------------------------------------------------------------------------
// Kept only so the pre-rewrite routes keep compiling. Do not use in new code.
//
// TODO(phase-2/3): migrate these callers to keysetQuery/keysetPage and delete
// this block. All three files are owned by other workstreams right now:
//   - server/api/sessions.ts:152  (dies with the sessions → agents cutover)
//   - server/api/templates.ts:29  (templates table is dropped in Phase 1)
//   - server/api/settings.ts:503,650 (containers + users lists — these two
//     survive the rewrite and genuinely need converting)
// ---------------------------------------------------------------------------

/** @deprecated Use {@link keysetQuery}. */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});

/** @deprecated Use {@link paginateKeyset}. */
export function paginate<T>(items: T[], page: number, perPage: number) {
  const total = items.length;
  const data = items.slice((page - 1) * perPage, page * perPage);
  return { data, total, page, perPage };
}
