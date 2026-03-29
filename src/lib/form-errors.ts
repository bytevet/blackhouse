/**
 * Converts TanStack Form field errors (which may be plain strings) into
 * the `{ message?: string }[]` shape that shadcn FieldError expects.
 */
export function toFieldErrors(
  errors: unknown[],
): Array<{ message?: string } | undefined> {
  return errors.map((e) =>
    typeof e === "string" ? { message: e } : (e as { message?: string } | undefined),
  );
}
