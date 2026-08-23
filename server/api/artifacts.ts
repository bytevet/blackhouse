import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { authMiddleware, type AuthEnv } from "../middleware/auth.js";
import { artifactBodyHeaders } from "../lib/artifact-csp.js";
import { channelAccess } from "./channels.js";

/**
 * Artifacts, addressed by their own id.
 *
 * Until this route existed the transcript could name an artifact but never
 * show one: the `artifacts` row, the `messages` row and the SSE frame all
 * worked, and the card drew an empty box because nothing on the server would
 * hand back a body. `GET /api/agents/:id/artifacts` deliberately omits `body`
 * (fifty rows of inline HTML is not a list payload), and there was no
 * per-artifact route to ask instead.
 *
 * Access is by **channel**, not by agent. Agents are workspace-shared — any
 * signed-in user may read any agent (`server/lib/agent-access.ts` says so, and
 * means it) — but an artifact is scoped to the channel it was submitted into,
 * and a private channel's contents are private. So every route here loads the
 * artifact, then its channel, then asks `channelAccess`. Reusing
 * `requireAgentAccess` would have inherited a gate that ignores the user
 * entirely.
 */

type ArtifactRow = typeof schema.artifacts.$inferSelect;

/**
 * 404 rather than 403, matching `notFound()` in `channels.ts`: "this artifact
 * does not exist" and "this artifact is in a room you cannot see" must be the
 * same answer, or the id itself becomes a membership oracle for a private
 * channel.
 */
function notFound(c: { json: (b: unknown, s: 404) => Response }) {
  return c.json({ error: "Artifact not found" }, 404);
}

/**
 * Load an artifact the requesting user is allowed to see, or null.
 *
 * The malformed-id catch is not defensive padding: Postgres rejects a
 * non-UUID at parse time, so `/api/artifacts/whatever` would otherwise be a
 * 500 instead of a 404.
 */
export async function loadReadableArtifact(
  id: string,
  user: { id: string; role?: string | null },
): Promise<ArtifactRow | null> {
  let row: ArtifactRow | undefined;
  try {
    [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, id)).limit(1);
  } catch {
    return null;
  }
  if (!row) return null;

  const [channel] = await db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.id, row.channelId))
    .limit(1);
  if (!channel) return null;

  const access = await channelAccess(channel, user);
  return access.canRead ? row : null;
}

/** The metadata projection — everything the card needs, never `body`. */
export function toArtifactSummary(row: ArtifactRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    contentType: row.contentType,
    url: row.url,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    channelId: row.channelId,
    agentId: row.agentId,
  };
}

/**
 * Body content type per kind.
 *
 * `link` and `file` have no body at all — they carry a `url`, and the card
 * renders an anchor. Returning null here is what makes `/content` a 404 for
 * them rather than an empty 200 that looks like a broken document.
 */
export function artifactContentType(row: Pick<ArtifactRow, "kind">): string | null {
  switch (row.kind) {
    case "html":
      return "text/html; charset=utf-8";
    case "text":
      return "text/plain; charset=utf-8";
    default:
      return null;
  }
}

const app = new Hono<AuthEnv>()

  .get("/:id", authMiddleware, async (c) => {
    const row = await loadReadableArtifact(c.req.param("id")!, c.get("session").user);
    if (!row) return notFound(c);
    return c.json(toArtifactSummary(row));
  })

  /**
   * The raw body, served as a document for the card's sandboxed iframe.
   *
   * `artifacts.contentType` is **agent-supplied** and is never echoed into the
   * response: the kind decides the type. An agent that could set its own
   * Content-Type could serve `text/html` from a `text` artifact, or something
   * a browser will sniff and execute in a context the card did not intend.
   *
   * The response never redirects to `artifacts.url` either. That column is
   * whatever the agent wrote, so a redirect would turn an authenticated route
   * on this origin into an open redirect with the app's own credentials in the
   * referrer chain.
   */
  .get("/:id/content", authMiddleware, async (c) => {
    const row = await loadReadableArtifact(c.req.param("id")!, c.get("session").user);
    if (!row) return notFound(c);

    const contentType = artifactContentType(row);
    if (contentType === null || row.body == null) return notFound(c);

    return c.body(row.body, 200, artifactBodyHeaders(contentType));
  });

export default app;
