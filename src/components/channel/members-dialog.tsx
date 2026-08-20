import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Bot, Info, Users, X } from "lucide-react";
import { Alert, Badge, Button, Dialog, SegmentedControl, Select, Spinner } from "@notyet.im/ui";
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
import { ActivityPill } from "./activity-pill";
import { agentStatusConfig, toneVar } from "@/lib/agent-status";
import type { AgentActivity, AgentStatus } from "@/db/schema";

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

  const options = useMemo(() => {
    if (!candidates) return [];
    return kind === "person"
      ? candidates.people.map((p) => ({ value: p.id, label: `${p.name} · ${p.email}` }))
      : candidates.agents.map((a) => ({ value: a.id, label: `@${a.handle} · ${a.displayName}` }));
  }, [candidates, kind]);

  const add = async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await addChannelMember(
        channelKey,
        kind === "person" ? { userId: choice } : { agentId: choice },
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
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (next: string) => void;
  onAdd: () => void;
  busy: boolean;
}) {
  const isPerson = kind === "person";
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
      <SegmentedControl
        value={kind}
        onChange={(next) => onKindChange(next === "agent" ? "agent" : "person")}
        items={[
          { value: "person", label: "Person" },
          { value: "agent", label: "Agent" },
        ]}
        label="What to add"
      />

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ color: "var(--ny-text-subtle)", display: "inline-flex", flex: "none" }}>
          {isPerson ? <Users size={14} strokeWidth={2} /> : <Bot size={14} strokeWidth={2} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/*
            A select rather than the design's free-text email box. Membership
            only ever resolves to someone already in the workspace, so offering
            the list is both simpler than a lookup and unable to produce a typo.
          */}
          <Select
            label={isPerson ? "Person to add" : "Agent to add"}
            value={value}
            onChange={onChange}
            options={[
              {
                value: "",
                label:
                  options.length === 0
                    ? isPerson
                      ? "Everyone is already here"
                      : "Every agent is already here"
                    : isPerson
                      ? "Pick someone in the workspace"
                      : "Pick an existing agent",
              },
              ...options,
            ]}
          />
        </div>
        <Button variant="primary" size="md" onClick={onAdd} disabled={!value} loading={busy}>
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
      <Badge tone={tone} variant="subtle" size="sm">
        {person.role ?? "member"}
      </Badge>
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
      <ActivityPill activity={agent.activity as AgentActivity} />
      <RemoveButton onClick={onRemove} label={`Remove @${agent.handle}`} busy={busy} />
    </div>
  );
}
