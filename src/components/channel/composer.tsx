import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button, SegmentedControl } from "@notyet.im/ui";
import { applyMention, findMentionQuery } from "./mentions";
import { MentionAutocomplete } from "./mention-autocomplete";
import type { AgentView, DeliveryMode } from "./types";

const MODE_ITEMS = [
  { value: "queue" as const, label: "Queue" },
  { value: "interrupt" as const, label: "Interrupt" },
];

/**
 * The composer: text, delivery mode, and the consequence of that mode.
 *
 * The hint next to the `SegmentedControl` is the load-bearing part. Interrupt
 * does something violent — it sends ESC to a live TUI mid-task and pastes over
 * whatever the agent was doing — and a segmented control alone makes that look
 * like a preference. So the hint **restyles to the danger tone** the moment
 * Interrupt is selected, and states the consequence in words. It has to be
 * legible without hovering anything: nobody hovers before hitting Enter.
 */
export function Composer({
  channelSlug,
  agents,
  value,
  onChange,
  mode,
  onModeChange,
  onSend,
}: {
  channelSlug: string;
  /** Roster of the channel — what the mention listbox offers. */
  agents: AgentView[];
  value: string;
  onChange: (value: string) => void;
  mode: DeliveryMode;
  onModeChange: (mode: DeliveryMode) => void;
  onSend: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listboxId = useId();
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  /** Escape dismisses the listbox without clearing the half-typed handle. */
  const [dismissed, setDismissed] = useState(false);

  const query = dismissed ? null : findMentionQuery(value, caret);
  const matches = query
    ? agents.filter(
        (agent) =>
          agent.handle.toLowerCase().startsWith(query.query) ||
          agent.displayName.toLowerCase().startsWith(query.query),
      )
    : [];
  const open = Boolean(query) && matches.length > 0;

  useEffect(() => {
    setActiveIndex(0);
  }, [query?.query, query?.start]);

  // Grow with the content, up to a ceiling — the transcript is what matters.
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [value]);

  const pick = (agent: AgentView) => {
    const next = applyMention(value, caret, agent.handle);
    onChange(next);
    setDismissed(false);
    // Caret lands after the inserted "@handle ".
    const at = (query?.start ?? 0) + agent.handle.length + 2;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(at, at);
      setCaret(at);
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(matches[activeIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (value.trim()) onSend();
    }
  };

  const interrupt = mode === "interrupt";

  return (
    <div
      style={{
        flex: "none",
        padding: "12px clamp(10px, 3vw, 26px) 18px",
        borderTop: "1px solid var(--ny-border)",
        background: "var(--ny-bg)",
      }}
    >
      <div style={{ maxWidth: 820, margin: "0 auto", position: "relative" }}>
        {open && (
          <MentionAutocomplete
            id={listboxId}
            agents={matches}
            activeIndex={activeIndex}
            onPick={pick}
            onHover={setActiveIndex}
            onClose={() => setDismissed(true)}
          />
        )}

        <div
          style={{
            border: "1px solid var(--ny-border-strong)",
            borderRadius: 14,
            background: "var(--ny-surface)",
            overflow: "hidden",
          }}
        >
          <textarea
            ref={textareaRef}
            className="bh-scroll"
            value={value}
            rows={1}
            placeholder={`Message #${channelSlug} — type @ to mention an agent`}
            aria-label={`Message #${channelSlug}`}
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            aria-activedescendant={
              open ? `${listboxId}-opt-${matches[activeIndex]?.id}` : undefined
            }
            aria-autocomplete="list"
            onChange={(event) => {
              onChange(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
              setDismissed(false);
            }}
            onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onClick={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onKeyDown={handleKeyDown}
            style={{
              width: "100%",
              display: "block",
              border: "none",
              background: "transparent",
              color: "var(--ny-text)",
              fontFamily: "var(--ny-font-sans)",
              fontSize: 14,
              lineHeight: 1.5,
              padding: "12px 14px 4px",
              resize: "none",
              outline: "none",
              minHeight: 44,
              maxHeight: 160,
            }}
          />

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px 10px",
              flexWrap: "wrap",
            }}
          >
            <SegmentedControl
              items={MODE_ITEMS}
              value={mode}
              onChange={onModeChange}
              variant="mono"
              label="Delivery mode"
            />

            <span
              // The consequence, not the setting. Danger tone when it bites.
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11.5,
                fontFamily: "var(--ny-font-mono)",
                color: interrupt ? "var(--ny-danger-text)" : "var(--ny-text-subtle)",
                transition: "color 120ms ease",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  flex: "none",
                  borderRadius: "50%",
                  background: interrupt ? "var(--ny-danger)" : "var(--ny-text-subtle)",
                }}
              />
              {interrupt
                ? "Stops the agent mid-task and runs this now"
                : "Delivers when the agent is idle"}
            </span>

            <div
              style={{
                marginLeft: "auto",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: "var(--ny-text-subtle)",
                  fontFamily: "var(--ny-font-mono)",
                }}
              >
                ⏎ to send
              </span>
              <Button
                variant="primary"
                size="sm"
                disabled={!value.trim()}
                onClick={() => value.trim() && onSend()}
              >
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
