import { clockTime } from "./format";

/**
 * A channel-level change, recorded in the transcript.
 *
 * Flipping auto-approve writes one of these, and that is the point: silently
 * disabling the only human gate on agent→agent dispatch is exactly the kind of
 * change that has to be visible in history. Quiet, mono, no avatar — it is a
 * fact about the room, not something anyone said.
 */
export function SystemLine({ body, createdAt }: { body: string; createdAt: Date }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        padding: "5px 8px 5px 58px",
        fontFamily: "var(--ny-font-mono)",
        fontSize: 11.5,
        color: "var(--ny-text-subtle)",
      }}
    >
      <span aria-hidden>·</span>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{body}</span>
      <time dateTime={createdAt.toISOString()} style={{ marginLeft: "auto", flex: "none" }}>
        {clockTime(createdAt)}
      </time>
    </div>
  );
}
