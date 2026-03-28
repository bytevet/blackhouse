import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "./auth";

/**
 * getServerSession — for use in route beforeLoad / loaders only.
 * This is a createServerFn because it crosses the client→server boundary.
 *
 * For auth checks inside other server function handlers, use
 * src/server/_auth.ts helpers instead (plain functions, no HTTP round-trip).
 */
export const getServerSession = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  return auth.api.getSession({ headers: request.headers });
});
