import { z } from "zod";

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});

export function paginate<T>(items: T[], page: number, perPage: number) {
  const total = items.length;
  const data = items.slice((page - 1) * perPage, page * perPage);
  return { data, total, page, perPage };
}
