import { toneTextVar } from "@/lib/agent-status";
import type { ToolCallView } from "./types";

/**
 * One tool call inside an expanded turn, as `glyph · verb · target · meta`.
 *
 * Four aligned columns in one monospace grid, so twenty of them read as a
 * *list of actions* you can scan down rather than twenty sentences you have to
 * read. Only the glyph carries colour; colouring the whole row would make a
 * turn compete with the prose reply above it.
 *
 * The four fields arrive pre-derived from the sidecar (`agent_events.payload`)
 * — the client never re-parses raw tool input, which can be an entire file.
 */
export function ToolCallRow({ call }: { call: ToolCallView }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "5px 2px",
        color: "var(--ny-text-muted)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 14,
          flex: "none",
          textAlign: "center",
          fontSize: 12,
          color: toneTextVar(call.tone),
        }}
      >
        {call.glyph}
      </span>
      <span style={{ minWidth: 44, flex: "none", color: "var(--ny-text-subtle)" }}>
        {call.verb}
      </span>
      <span
        style={{
          color: "var(--ny-text)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={call.target}
      >
        {call.target}
      </span>
      <span
        style={{
          marginLeft: "auto",
          flex: "none",
          paddingLeft: 8,
          color: "var(--ny-text-subtle)",
          fontSize: 11,
        }}
      >
        {call.meta}
      </span>
    </div>
  );
}
