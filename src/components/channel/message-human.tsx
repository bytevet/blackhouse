import { UserAvatar } from "./agent-avatar";
import { clockTime } from "./format";
import { segmentBody } from "./mentions";
import { QueuedChip } from "./queued-chip";
import type { QueuedView, UserView } from "./types";

/**
 * A human's message: round avatar, name, time, prose with mention chips.
 *
 * This is the loudest row in the transcript and that is intentional — it is
 * the only kind a person authored, and everything below it is a consequence
 * of it. Agent output is quieter by design.
 */
export function MessageHuman({
  author,
  createdAt,
  body,
  knownHandles,
  queued,
  onCancelQueued,
}: {
  author: UserView;
  createdAt: Date;
  body: string;
  /** Handles that resolve to a real agent — unknown ones stay plain text. */
  knownHandles: string[];
  queued?: QueuedView;
  onCancelQueued?: () => void;
}) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "10px 8px", borderRadius: 10 }}>
      <UserAvatar name={author.name} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{author.name}</span>
          <time
            dateTime={createdAt.toISOString()}
            style={{
              fontSize: 11,
              color: "var(--ny-text-subtle)",
              fontFamily: "var(--ny-font-mono)",
            }}
          >
            {clockTime(createdAt)}
          </time>
        </div>
        <div
          style={{
            marginTop: 3,
            lineHeight: 1.55,
            color: "var(--ny-text)",
            overflowWrap: "anywhere",
          }}
        >
          <MentionText body={body} knownHandles={knownHandles} />
        </div>
        {queued && <QueuedChip queued={queued} onCancel={onCancelQueued} />}
      </div>
    </div>
  );
}

/**
 * Message body with `@handle` rendered as a chip.
 *
 * A chip is a promise that a run was created, so only *resolved* handles get
 * one; `@ghost` renders as the text the author typed. Anything else would
 * imply an agent is working when nothing was dispatched.
 */
export function MentionText({ body, knownHandles }: { body: string; knownHandles: string[] }) {
  return (
    <>
      {segmentBody(body, knownHandles).map((segment, i) =>
        segment.type === "mention" && segment.known ? (
          <span
            key={i}
            style={{
              fontFamily: "var(--ny-font-mono)",
              color: "var(--ny-accent-text)",
              background: "var(--ny-accent-subtle)",
              padding: "1px 5px",
              borderRadius: 5,
            }}
          >
            {segment.text}
          </span>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}
