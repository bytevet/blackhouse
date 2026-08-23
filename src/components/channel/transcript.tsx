import { useEffect, useRef } from "react";
import { CircleAlert, RotateCw } from "lucide-react";
import { Button } from "@notyet.im/ui";
import { DispatchCard } from "./dispatch-card";
import { dayKey, dayLabel } from "./format";
import { MessageAgentText } from "./message-agent-text";
import { MessageHuman } from "./message-human";
import { MessageTurn } from "./message-turn";
import { ArtifactCard } from "./artifact-card";
import { SystemLine } from "./system-line";
import type { TranscriptEntry } from "./types";

/**
 * The scroller. Day dividers, one row per entry, pinned to the bottom.
 *
 * It knows nothing about fetching: entries arrive as a prop, already ordered
 * oldest → newest the way a keyset page does, and the load/empty/error states
 * arrive as flags. The one rule it enforces is that **a failure never renders
 * as an empty channel** — "nothing was said here" and "we could not load what
 * was said here" are different facts, and a reader cannot tell them apart from
 * an empty scroller.
 */
export function Transcript({
  entries,
  knownHandles,
  loading = false,
  error = null,
  onRetry,
  hasMore = false,
  loadingMore = false,
  onLoadOlder,
  onApproveDispatch,
  onDenyDispatch,
  onCancelQueued,
}: {
  entries: TranscriptEntry[];
  /** Handles that resolve to a real agent, for mention chips. */
  knownHandles: string[];
  /** First page in flight. */
  loading?: boolean;
  /** Why the transcript could not be loaded. Rendered above whatever we do have. */
  error?: string | null;
  onRetry?: () => void;
  /** More history exists behind the keyset cursor. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadOlder?: () => void;
  onApproveDispatch?: (dispatchId: string, prompt: string) => void;
  onDenyDispatch?: (dispatchId: string) => void;
  /** Omitted when there is nothing that can cancel — the chip then shows no
   *  cancel affordance rather than a button that does not reach the run. */
  onCancelQueued?: (runId: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const newestId = entries[entries.length - 1]?.id;

  // Follow the tail. A live transcript that does not scroll is a transcript
  // you have to babysit. Keyed on the *newest* entry rather than the count, so
  // prepending a page of history does not yank you back to the bottom.
  useEffect(() => {
    // `?.` on the method too: not every host implements it (jsdom does not),
    // and the transcript must still render where it does not.
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [newestId]);

  let lastDay = "";

  return (
    <div
      className="bh-scroll"
      style={{
        flex: 1,
        overflowY: "auto",
        minWidth: 0,
        padding: "22px clamp(10px, 3vw, 26px) 8px",
      }}
    >
      <div
        style={{
          maxWidth: 820,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {error && <TranscriptError message={error} onRetry={onRetry} />}

        {hasMore && (
          <div style={{ display: "flex", justifyContent: "center", padding: "2px 0 12px" }}>
            <Button variant="ghost" size="sm" disabled={loadingMore} onClick={onLoadOlder}>
              {loadingMore ? "Loading…" : "Load older messages"}
            </Button>
          </div>
        )}

        {loading && entries.length === 0 && <TranscriptNote>Loading transcript…</TranscriptNote>}

        {!loading && !error && entries.length === 0 && (
          <TranscriptNote>
            Nothing here yet. Mention an agent with <code>@handle</code> to start a run.
          </TranscriptNote>
        )}

        {entries.map((entry) => {
          const key = dayKey(entry.createdAt);
          const divider = key !== lastDay;
          lastDay = key;
          return (
            <div key={entry.id}>
              {divider && <DayDivider label={dayLabel(entry.createdAt)} />}
              <TranscriptRow
                entry={entry}
                knownHandles={knownHandles}
                onApproveDispatch={onApproveDispatch}
                onDenyDispatch={onDenyDispatch}
                onCancelQueued={onCancelQueued}
              />
            </div>
          );
        })}
        <div ref={bottomRef} style={{ height: 8 }} />
      </div>
    </div>
  );
}

function TranscriptRow({
  entry,
  knownHandles,
  onApproveDispatch,
  onDenyDispatch,
  onCancelQueued,
}: {
  entry: TranscriptEntry;
  knownHandles: string[];
  onApproveDispatch?: (dispatchId: string, prompt: string) => void;
  onDenyDispatch?: (dispatchId: string) => void;
  onCancelQueued?: (runId: string) => void;
}) {
  switch (entry.kind) {
    case "human":
      return (
        <MessageHuman
          author={entry.author}
          createdAt={entry.createdAt}
          body={entry.body}
          knownHandles={knownHandles}
          queued={entry.queued}
          onCancelQueued={
            entry.queued && onCancelQueued ? () => onCancelQueued(entry.queued!.runId) : undefined
          }
        />
      );
    case "agent-text":
      return (
        <MessageAgentText
          agent={entry.agent}
          createdAt={entry.createdAt}
          body={entry.body}
          artifact={entry.artifact}
        />
      );
    case "turn":
      return <MessageTurn agent={entry.agent} turn={entry.turn} />;
    case "artifact":
      return (
        <div style={{ display: "flex", gap: 12, padding: "2px 8px" }}>
          <div style={{ width: 38, flex: "none" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <ArtifactCard artifact={entry.artifact} />
          </div>
        </div>
      );
    case "dispatch":
      return (
        <DispatchCard
          dispatch={entry.dispatch}
          onApprove={(prompt) => onApproveDispatch?.(entry.dispatch.id, prompt)}
          onDeny={() => onDenyDispatch?.(entry.dispatch.id)}
        />
      );
    case "system":
      return <SystemLine body={entry.body} createdAt={entry.createdAt} />;
  }
}

/**
 * The load failure, stated as a failure.
 *
 * Danger-toned and explicit about what is missing, because the alternative — an
 * empty scroller — reads as "this channel is quiet", which is the single most
 * misleading thing this screen could say.
 */
function TranscriptError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        margin: "0 0 14px",
        padding: "11px 13px",
        borderRadius: 10,
        border: "1px solid var(--ny-danger-border)",
        background: "var(--ny-danger-subtle)",
      }}
    >
      <CircleAlert
        size={16}
        strokeWidth={2}
        style={{ flex: "none", marginTop: 1, color: "var(--ny-danger-text)" }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ny-danger-text)" }}>
          Could not load this channel&apos;s messages
        </div>
        <div
          style={{
            fontSize: 11.5,
            fontFamily: "var(--ny-font-mono)",
            color: "var(--ny-text-muted)",
            marginTop: 3,
            overflowWrap: "anywhere",
          }}
        >
          {message}
        </div>
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RotateCw size={13} strokeWidth={2} />
          Retry
        </Button>
      )}
    </div>
  );
}

function TranscriptNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "26px 8px",
        textAlign: "center",
        fontSize: 12.5,
        color: "var(--ny-text-subtle)",
        fontFamily: "var(--ny-font-mono)",
      }}
    >
      {children}
    </div>
  );
}

function DayDivider({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "4px 0 14px" }}>
      <div style={{ flex: 1, height: 1, background: "var(--ny-border)" }} />
      <span
        style={{ fontSize: 11, color: "var(--ny-text-subtle)", fontFamily: "var(--ny-font-mono)" }}
      >
        {label}
      </span>
      <div style={{ flex: 1, height: 1, background: "var(--ny-border)" }} />
    </div>
  );
}
