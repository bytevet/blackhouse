import { useEffect, useRef } from "react";
import { useEscapeKey } from "@notyet.im/ui";
import { ActivityPill } from "./activity-pill";
import { AgentAvatar } from "./agent-avatar";
import type { AgentView } from "./types";

/**
 * The `@mention` listbox.
 *
 * Deliberately **not** a `Select`: a form control cannot back an inline text
 * trigger. The real trigger is a regex over the composer's text, the caret
 * stays in the textarea the whole time, and this is a listbox the textarea
 * points at with `aria-activedescendant` — which is also the ARIA combobox
 * pattern, so the keyboard behaviour comes out right rather than being faked.
 *
 * Every row carries **live status**: the process dot on the avatar, the
 * activity pill, and the agent's status line. Seeing that `@backend` is busy
 * running tests *before* you send is the difference between choosing Queue
 * deliberately and being surprised four minutes later.
 */
export function MentionAutocomplete({
  id,
  agents,
  activeIndex,
  onPick,
  onHover,
  onClose,
}: {
  /** Shared with the textarea's `aria-controls`. */
  id: string;
  agents: AgentView[];
  activeIndex: number;
  onPick: (agent: AgentView) => void;
  onHover: (index: number) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEscapeKey(true, onClose);

  // Keep the active row in view when the keyboard is driving.
  useEffect(() => {
    listRef.current?.children[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  if (agents.length === 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        left: 0,
        width: "min(340px, 100%)",
        background: "var(--ny-surface-raised)",
        border: "1px solid var(--ny-border-strong)",
        borderRadius: 12,
        boxShadow: "var(--ny-shadow-lg)",
        overflow: "hidden",
        zIndex: 5,
      }}
    >
      <div
        style={{
          padding: "7px 12px",
          fontSize: 10.5,
          fontFamily: "var(--ny-font-mono)",
          textTransform: "uppercase",
          letterSpacing: ".05em",
          color: "var(--ny-text-subtle)",
          borderBottom: "1px solid var(--ny-border)",
        }}
      >
        Mention an agent — live status
      </div>
      <ul
        ref={listRef}
        id={id}
        role="listbox"
        aria-label="Agents"
        className="bh-scroll"
        style={{ margin: 0, padding: 0, listStyle: "none", maxHeight: 260, overflowY: "auto" }}
      >
        {agents.map((agent, index) => {
          const active = index === activeIndex;
          return (
            <li
              key={agent.id}
              id={`${id}-opt-${agent.id}`}
              role="option"
              aria-selected={active}
              onMouseEnter={() => onHover(index)}
              // `mousedown` rather than `click`: the textarea must not lose
              // focus before the pick is applied, or the caret jumps.
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(agent);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                cursor: "pointer",
                background: active ? "var(--ny-surface-hover)" : "transparent",
              }}
            >
              <AgentAvatar agent={agent} size={26} surface="var(--ny-surface-raised)" />
              <span
                style={{
                  fontFamily: "var(--ny-font-mono)",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--ny-text)",
                  flex: "none",
                }}
              >
                @{agent.handle}
              </span>
              <ActivityPill activity={agent.activity} size="sm" />
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: "var(--ny-font-mono)",
                  fontSize: 11,
                  color: "var(--ny-text-subtle)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 130,
                }}
              >
                {agent.statusLine ?? agent.status}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
