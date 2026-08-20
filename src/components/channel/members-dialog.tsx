import { useCallback, useEffect, useId, useMemo, useState } from "react";
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
   * — and it is what the datalist offers. `value` is the id the API wants.
   */
  const options = useMemo(() => {
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
  options: Array<{ value: string; token: string; label: string }>;
  value: string;
  onChange: (next: string) => void;
  onAdd: () => void;
  busy: boolean;
}) {
  const isPerson = kind === "person";
  const listId = useId();
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
            The design's free-text box, backed by a datalist rather than by a
            lookup. Membership only ever resolves to someone already in the
            workspace, so the list is both the suggestion and the validation:
            what you type is matched against it on Add, and an unmatched value
            is refused rather than sent.
          */}
          <input
            list={listId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onAdd();
              }
            }}
            placeholder={isPerson ? "name@example.com" : "@handle — pick an existing agent"}
            aria-label={isPerson ? "Person to add" : "Agent to add"}
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
          <datalist id={listId}>
            {options.map((o) => (
              <option key={o.value} value={o.token} />
            ))}
          </datalist>
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
