import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Bot, Info, Users, X } from "lucide-react";
import { Alert, Button, Dialog, Spinner } from "@notyet.im/ui";
import {
  addChannelMember,
  fetchChannelMembers,
  fetchMemberCandidates,
  removeChannelMember,
  type ChannelAgentMember,
  type ChannelMembers,
  type ChannelPerson,
  type MemberCandidates,
} from "./channel-api";
import { agentStatusConfig, toneVar } from "@/lib/agent-status";
import type { AgentStatus } from "@/db/schema";

/**
 * Who is in this channel — the people who can read it, and the agents that can
 * be mentioned in it.
 *
 * Both halves are load-bearing rather than informational. An agent that is not
 * a member cannot be mentioned here at all, and in a private channel a person
 * who is not a member cannot read the room. That is the whole reason this
 * dialog exists: before it, the roster was a number in the header and nothing
 * consulted it.
 *
 * The design's `pending` invite chip is deliberately absent. Settings → Members
 * creates accounts directly with a starting password — there is no invite state
 * to be pending in, and a chip that can never appear is a promise the product
 * does not keep.
 */

const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: 12,
  borderBottom: "1px solid var(--ny-border)",
};

/** The last row in a card owns no border; the card's own edge is the line. */
const lastRow = (isLast: boolean): React.CSSProperties =>
  isLast ? { ...ROW, borderBottom: "none" } : ROW;

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "var(--ny-font-mono)",
  textTransform: "uppercase",
  letterSpacing: ".05em",
  color: "var(--ny-text-subtle)",
};

/**
 * The design's chip: 9.5px uppercase mono in a 4px-radius box.
 *
 * Not `Badge`, which is a rounded pill at roughly twice the size — these sit at
 * the end of a dense row and are meant to read as a marginal note, not as a
 * status people look at first. `strong` tints the whole thing; the default is
 * quiet, on the sunken surface.
 */
function Chip({
  tone,
  strong = false,
  children,
}: {
  tone: "info" | "warning" | "success" | "danger" | "neutral";
  strong?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      style={{
        fontFamily: "var(--ny-font-mono)",
        fontSize: 9.5,
        textTransform: "uppercase",
        letterSpacing: ".04em",
        borderRadius: 4,
        padding: "0 4px",
        flex: "none",
        ...(strong && tone !== "neutral"
          ? {
              border: `1px solid var(--ny-${tone}-border)`,
              color: `var(--ny-${tone}-text)`,
              background: `var(--ny-${tone}-subtle)`,
            }
          : {
              border: "1px solid var(--ny-border)",
              color: "var(--ny-text-subtle)",
              background: "var(--ny-surface-sunken)",
            }),
      }}
    >
      {children}
    </span>
  );
}

/** The design's Person/Agent picker: two pills, not a segmented control. */
function AddTab({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className="bh-reset bh-focusable"
      style={{
        padding: "4px 12px",
        borderRadius: 20,
        cursor: "pointer",
        fontFamily: "var(--ny-font-mono)",
        fontSize: 11.5,
        ...(on
          ? {
              border: "1px solid var(--ny-accent)",
              background: "var(--ny-accent-subtle)",
              color: "var(--ny-accent-text)",
              fontWeight: 600,
            }
          : { border: "1px solid var(--ny-border)", color: "var(--ny-text-muted)" }),
      }}
    >
      {children}
    </button>
  );
}

/**
 * A row of the add picker: the id the API wants, the string a person types, and
 * the human name beside it. Both halves are searched — someone looking for a
 * teammate remembers the name as often as the address.
 */
interface Candidate {
  value: string;
  token: string;
  label: string;
}

const CARD: React.CSSProperties = {
  border: "1px solid var(--ny-border)",
  borderRadius: 12,
  overflow: "hidden",
};

export function MembersDialog({
  open,
  onClose,
  channelKey,
  channelSlug,
  /** Bumped by the shell when a `channel.members` frame arrives. */
  revision = 0,
}: {
  open: boolean;
  onClose: () => void;
  channelKey: string;
  channelSlug: string;
  revision?: number;
}) {
  const [members, setMembers] = useState<ChannelMembers | null>(null);
  const [candidates, setCandidates] = useState<MemberCandidates | null>(null);
  const [kind, setKind] = useState<"person" | "agent">("person");
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, c] = await Promise.all([
        fetchChannelMembers(channelKey),
        fetchMemberCandidates(channelKey),
      ]);
      setMembers(m);
      setCandidates(c);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [channelKey]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load, revision]);

  // Reset the picker between openings, so a half-finished add does not reappear
  // days later against a different channel.
  useEffect(() => {
    if (!open) {
      setChoice("");
      setError(null);
    }
  }, [open]);

  /**
   * What you can type, and what it resolves to.
   *
   * `token` is the thing a person would actually write — an email, or `@handle`
   * — and it is what the suggestions offer. `value` is the id the API wants.
   */
  const options = useMemo<Candidate[]>(() => {
    if (!candidates) return [];
    return kind === "person"
      ? candidates.people.map((p) => ({ value: p.id, token: p.email, label: p.name }))
      : candidates.agents.map((a) => ({
          value: a.id,
          token: `@${a.handle}`,
          label: a.displayName,
        }));
  }, [candidates, kind]);

  const add = async () => {
    const typed = choice.trim();
    if (!typed) return;

    // Resolve what was typed against the candidate list. The list is the only
    // source of truth for who may be added, so an unmatched value is refused
    // here rather than posted for the server to reject with a validation error
    // about ids the person never saw.
    const needle = typed.toLowerCase().replace(/^@/, "");
    const match = options.find((o) => o.token.toLowerCase().replace(/^@/, "") === needle);
    if (!match) {
      setError(
        kind === "person"
          ? `No one in this workspace has the address “${typed}”. Add them in Settings → Members first.`
          : `No agent is called “${typed}”. Pick one of the suggestions, or create it first.`,
      );
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await addChannelMember(
        channelKey,
        kind === "person" ? { userId: match.value } : { agentId: match.value },
      );
      setChoice("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (memberId: string) => {
    setBusy(true);
    setError(null);
    try {
      await removeChannelMember(channelKey, memberId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="Channel members"
      description={`Who can read #${channelSlug}, and which agents can be mentioned in it.`}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="ghost" size="md" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {error && (
          <Alert tone="danger" title="That did not work" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}

        <AddRow
          kind={kind}
          onKindChange={(next) => {
            setKind(next);
            setChoice("");
          }}
          options={options}
          value={choice}
          onChange={setChoice}
          onAdd={() => void add()}
          busy={busy}
        />

        {loading && !members ? (
          <div style={{ display: "grid", placeItems: "center", padding: 28 }} aria-busy="true">
            <Spinner label="Loading members" />
          </div>
        ) : (
          <>
            <Section label="People" meta={`${members?.people.length ?? 0}`}>
              {members?.people.length ? (
                members.people.map((p, i) => (
                  <PersonRow
                    key={p.memberId}
                    person={p}
                    last={i === members.people.length - 1}
                    onRemove={() => void remove(p.memberId)}
                    busy={busy}
                  />
                ))
              ) : (
                <EmptyRow>
                  No one has been added yet. #{channelSlug} is public, so anyone in the workspace
                  can still read it.
                </EmptyRow>
              )}
            </Section>

            <Section label="Agents" meta="mentionable here">
              {members?.agents.length ? (
                members.agents.map((a, i) => (
                  <AgentMemberRow
                    key={a.memberId}
                    agent={a}
                    last={i === members.agents.length - 1}
                    onRemove={() => void remove(a.memberId)}
                    busy={busy}
                  />
                ))
              ) : (
                <EmptyRow>No agents yet — nothing can be mentioned in this channel.</EmptyRow>
              )}
            </Section>
          </>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            fontSize: 11,
            color: "var(--ny-text-subtle)",
            lineHeight: 1.45,
          }}
        >
          <Info size={13} strokeWidth={2} style={{ flex: "none", marginTop: 1 }} />
          <span>
            Removing an agent stops it being mentionable here; its sandbox keeps running.
            Workspace-wide roles live in{" "}
            <Link to="/settings/members" onClick={onClose}>
              Settings → Members
            </Link>
            .
          </span>
        </div>
      </div>
    </Dialog>
  );
}

/** Pick a kind, pick who, add them. */
function AddRow({
  kind,
  onKindChange,
  options,
  value,
  onChange,
  onAdd,
  busy,
}: {
  kind: "person" | "agent";
  onKindChange: (next: "person" | "agent") => void;
  options: Candidate[];
  value: string;
  onChange: (next: string) => void;
  onAdd: () => void;
  busy: boolean;
}) {
  const isPerson = kind === "person";
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  /** `-1` is "nothing highlighted" — the state in which Enter still means Add. */
  const [activeIndex, setActiveIndex] = useState(-1);

  // Substring on both halves, because people search with whichever half they
  // remember: the address or the name, the handle or what the agent is called.
  const query = value.trim().toLowerCase();
  const matches = useMemo(
    () =>
      query
        ? options.filter(
            (o) => o.token.toLowerCase().includes(query) || o.label.toLowerCase().includes(query),
          )
        : options,
    [options, query],
  );
  const showList = open && matches.length > 0;
  const activeOption = activeIndex >= 0 ? matches[activeIndex] : undefined;

  // A new query invalidates the highlight — row 3 of the old list is not row 3
  // of the new one — and drops back to nothing highlighted, so Enter after
  // typing a whole address adds *that* rather than whatever was under the
  // cursor two keystrokes ago.
  useEffect(() => {
    setActiveIndex(-1);
  }, [query]);

  // Person/Agent replaces the candidate list wholesale and the parent clears
  // the box with it; a listbox left open would be offering the old one.
  useEffect(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, [kind]);

  const pick = (option: Candidate) => {
    onChange(option.token);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (matches.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      if (!showList) {
        setOpen(true);
        setActiveIndex(step === 1 ? 0 : matches.length - 1);
        return;
      }
      setActiveIndex((i) =>
        i < 0
          ? step === 1
            ? 0
            : matches.length - 1
          : (i + step + matches.length) % matches.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      // Enter takes the highlighted row if there is one, and otherwise submits
      // what was typed — which is how someone who pasted a whole address gets
      // through without ever looking at the suggestions.
      if (activeOption) pick(activeOption);
      else onAdd();
      return;
    }
    if (event.key === "Escape" && showList) {
      // `preventDefault` is load-bearing: this lives inside a native
      // `<dialog>`, where Escape is a close request. Without it, dismissing the
      // suggestions takes the whole dialog with them. `stopPropagation` keeps
      // it away from the window-level Escape handlers other overlays install.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        border: "1px solid var(--ny-border)",
        borderRadius: 12,
        background: "var(--ny-surface-sunken)",
        padding: 12,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <AddTab on={isPerson} onClick={() => onKindChange("person")}>
          Person
        </AddTab>
        <AddTab on={!isPerson} onClick={() => onKindChange("agent")}>
          Agent
        </AddTab>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div
          style={{
            position: "relative",
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            border: "1px solid var(--ny-border-strong)",
            borderRadius: 8,
            background: "var(--ny-surface)",
            padding: "0 12px",
          }}
        >
          <span style={{ color: "var(--ny-text-subtle)", display: "inline-flex", flex: "none" }}>
            {isPerson ? <Users size={14} strokeWidth={2} /> : <Bot size={14} strokeWidth={2} />}
          </span>
          {/*
            The design's free-text box, with the candidate list under it rather
            than behind a browser's idea of a datalist — which offers no
            filtering worth the name, renders differently in every browser, and
            in this one simply did not show. Membership only ever resolves to
            someone already in the workspace, so the list is both the suggestion
            and the validation: what you type is matched against it on Add, and
            an unmatched value is refused rather than sent.
          */}
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            // Focus alone opens it, so this only matters for a click that
            // lands while the box is already focused and was dismissed.
            onMouseDown={() => setOpen(true)}
            onBlur={() => {
              setOpen(false);
              setActiveIndex(-1);
            }}
            onKeyDown={onKeyDown}
            placeholder={isPerson ? "name@example.com" : "@handle — pick an existing agent"}
            aria-label={isPerson ? "Person to add" : "Agent to add"}
            role="combobox"
            aria-expanded={showList}
            aria-controls={showList ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              activeOption ? `${listboxId}-opt-${activeOption.value}` : undefined
            }
            autoComplete="off"
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              background: "transparent",
              color: "var(--ny-text)",
              fontFamily: "var(--ny-font-mono)",
              fontSize: 13,
              padding: "8px 0",
              outline: "none",
            }}
          />
          {showList && (
            <SuggestionList
              id={listboxId}
              label={isPerson ? "People not in this channel" : "Agents not in this channel"}
              kind={kind}
              options={matches}
              activeIndex={activeIndex}
              onPick={pick}
              onHover={setActiveIndex}
            />
          )}
        </div>
        <Button variant="primary" size="md" onClick={onAdd} disabled={!value.trim()} loading={busy}>
          Add
        </Button>
      </div>

      <div style={{ fontSize: 11, color: "var(--ny-text-subtle)", lineHeight: 1.4 }}>
        {isPerson
          ? "Workspace members only. Not in the workspace yet? Add them in Settings → Members first."
          : "Adding an agent lets anyone here @mention it. It keeps its own sandbox and budget."}
      </div>
    </div>
  );
}

/**
 * The candidate listbox.
 *
 * Deliberately **not** `MentionAutocomplete` itself, which is the same control
 * for the composer: every row there is an agent and renders as one — avatar
 * with the process dot, activity pill, status line — and half of this list is
 * people. What is shared is the pattern, and the pattern is the part that
 * matters: the input keeps focus and points at this listbox with
 * `aria-activedescendant`, which is the ARIA combobox shape, so the keyboard
 * behaviour comes out right rather than being faked. The surface treatment is
 * copied on purpose — two dropdowns in one product that do not look alike read
 * as two different mechanisms.
 *
 * `mousedown` rather than `click`, for the same reason as there: the input must
 * not lose focus before the pick is applied, or `onBlur` closes the list out
 * from under the click.
 */
function SuggestionList({
  id,
  label,
  kind,
  options,
  activeIndex,
  onPick,
  onHover,
}: {
  /** Shared with the input's `aria-controls`. */
  id: string;
  /** Names the listbox, and captions it — the same sentence does both jobs. */
  label: string;
  kind: "person" | "agent";
  options: Candidate[];
  activeIndex: number;
  onPick: (option: Candidate) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the active row in view when the keyboard is driving.
  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current?.children[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        left: 0,
        right: 0,
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
        {label}
      </div>
      <ul
        ref={listRef}
        id={id}
        role="listbox"
        aria-label={label}
        className="bh-scroll"
        style={{ margin: 0, padding: 0, listStyle: "none", maxHeight: 220, overflowY: "auto" }}
      >
        {options.map((option, index) => {
          const active = index === activeIndex;
          return (
            <li
              key={option.value}
              id={`${id}-opt-${option.value}`}
              role="option"
              aria-selected={active}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(option);
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
              <span
                aria-hidden
                style={{ color: "var(--ny-text-subtle)", display: "inline-flex", flex: "none" }}
              >
                {kind === "person" ? (
                  <Users size={14} strokeWidth={2} />
                ) : (
                  <Bot size={14} strokeWidth={2} />
                )}
              </span>
              {/* The token leads, because the token is what lands in the box. */}
              <span
                style={{
                  fontFamily: "var(--ny-font-mono)",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--ny-text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {option.token}
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 11,
                  color: "var(--ny-text-subtle)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 140,
                  flex: "none",
                }}
              >
                {option.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Section({
  label,
  meta,
  children,
}: {
  label: string;
  meta: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span style={SECTION_LABEL}>{label}</span>
        <span style={{ ...SECTION_LABEL, textTransform: "none", letterSpacing: 0 }}>{meta}</span>
      </div>
      <div style={CARD}>{children}</div>
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ...ROW, borderBottom: "none", fontSize: 12, color: "var(--ny-text-subtle)" }}>
      {children}
    </div>
  );
}

function RemoveButton({
  onClick,
  label,
  busy,
}: {
  onClick: () => void;
  label: string;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      title={label}
      className="bh-reset bh-focusable bh-remove"
      style={{
        display: "grid",
        placeItems: "center",
        width: 24,
        height: 24,
        flex: "none",
        borderRadius: 8,
        cursor: busy ? "default" : "pointer",
        color: "var(--ny-text-subtle)",
      }}
    >
      <X size={14} strokeWidth={2} />
    </button>
  );
}

function PersonRow({
  person,
  last,
  onRemove,
  busy,
}: {
  person: ChannelPerson;
  last: boolean;
  onRemove: () => void;
  busy: boolean;
}) {
  const initials = person.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  const tone = person.role === "admin" ? "warning" : "info";

  return (
    <div style={lastRow(last)}>
      <span
        aria-hidden
        style={{
          width: 32,
          height: 32,
          flex: "none",
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          fontSize: 11,
          fontWeight: 700,
          background: `var(--ny-${tone}-subtle)`,
          color: `var(--ny-${tone}-text)`,
        }}
      >
        {initials}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--ny-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {person.name}
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--ny-font-mono)",
            color: "var(--ny-text-subtle)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {person.email}
        </div>
      </div>
      {/* `strong` only for a role that carries authority; an ordinary member
          gets the quiet variant, so the eye lands on the exceptions. */}
      <Chip tone={tone} strong={person.role === "admin"}>
        {person.role ?? "member"}
      </Chip>
      <RemoveButton onClick={onRemove} label={`Remove ${person.name}`} busy={busy} />
    </div>
  );
}

function AgentMemberRow({
  agent,
  last,
  onRemove,
  busy,
}: {
  agent: ChannelAgentMember;
  last: boolean;
  onRemove: () => void;
  busy: boolean;
}) {
  const initials = agent.handle.slice(0, 2).toUpperCase();
  // The process dot is the container; the pill beside the handle is the
  // process inside it. `src/lib/agent-status.ts` owns that mapping.
  const statusEntry = agentStatusConfig[agent.status as AgentStatus];

  return (
    <div style={lastRow(last)}>
      <span style={{ position: "relative", flex: "none" }}>
        <span
          aria-hidden
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: "var(--ny-surface-raised)",
            border: "1px solid var(--ny-accent-border)",
            display: "grid",
            placeItems: "center",
            fontFamily: "var(--ny-font-mono)",
            fontSize: 11,
            fontWeight: 700,
            color: "var(--ny-accent-text)",
          }}
        >
          {initials}
        </span>
        <span
          aria-hidden
          title={`${agent.status} container`}
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: toneVar(statusEntry?.tone ?? "neutral"),
            border: "2px solid var(--ny-surface)",
          }}
        />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: "var(--ny-font-mono)",
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--ny-text)",
          }}
        >
          @{agent.handle}
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--ny-font-mono)",
            color: "var(--ny-text-subtle)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {agent.statusLine ?? agent.status}
        </div>
      </div>
      {/* Activity, in the row's own chip rather than the rail's pill: this is a
          dense list and the pill is built for a roster row twice this height. */}
      <Chip
        tone={agent.activity === "busy" ? "info" : "neutral"}
        strong={agent.activity === "busy"}
      >
        {agent.activity}
      </Chip>
      <RemoveButton onClick={onRemove} label={`Remove @${agent.handle}`} busy={busy} />
    </div>
  );
}
