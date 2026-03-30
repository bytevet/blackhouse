import { hc } from "hono/client";
import type { AppType } from "@server/index";

export const client = hc<AppType>("/", {
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, credentials: "include" }),
});

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Unwrap a hono client response — throws ApiError on non-2xx */
export async function unwrap<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new ApiError(response.status, text);
  }
  if (response.headers.get("content-type")?.includes("application/json")) {
    return response.json();
  }
  return response.text() as T;
}
