import { useEffect, useRef } from "react";
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
 * oldest → newest the way a keyset page does. When `GET /api/channels/:slug/
 * messages` lands, this component does not change — its parent gains a hook.
 */
export function Transcript({
  entries,
  knownHandles,
  onApproveDispatch,
  onDenyDispatch,
  onCancelQueued,
}: {
  entries: TranscriptEntry[];
  /** Handles that resolve to a real agent, for mention chips. */
  knownHandles: string[];
  onApproveDispatch?: (dispatchId: string, prompt: string) => void;
  onDenyDispatch?: (dispatchId: string) => void;
  onCancelQueued?: (runId: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Follow the tail. A live transcript that does not scroll is a transcript
  // you have to babysit.
  useEffect(() => {
    // `?.` on the method too: not every host implements it (jsdom does not),
    // and the transcript must still render where it does not.
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [entries.length]);

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
          onCancelQueued={entry.queued ? () => onCancelQueued?.(entry.queued!.runId) : undefined}
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
