import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router";
import { ChannelHeader } from "@/components/channel/channel-header";
import { ChannelSidebar } from "@/components/channel/channel-sidebar";
import { ChannelStyles } from "@/components/channel/channel-styles";
import { Composer } from "@/components/channel/composer";
import { CreateChannelDialog } from "@/components/channel/create-channel-dialog";
import { mentionedHandles } from "@/components/channel/mentions";
import {
  mockAgents,
  mockChannels,
  mockCurrentUser,
  mockTranscript,
  mockWorkspace,
} from "@/components/channel/mock-data";
import { Transcript } from "@/components/channel/transcript";
import type {
  AgentView,
  ChannelView,
  DeliveryMode,
  TranscriptEntry,
} from "@/components/channel/types";
import { useMediaQuery } from "@/components/channel/use-media-query";

/**
 * The Channel View — the primary screen.
 *
 * Three regions: the rail (channels + agent roster), the transcript, and the
 * composer. Everything below this file is pure and presentational; this is the
 * only component that holds state, which is what makes the data swap a
 * one-file change when `GET /api/channels/:slug/messages` and the SSE stream
 * land. Today the state is seeded from `components/channel/mock-data.ts` and
 * mutated locally so the interactions are real: approving a dispatch, queueing
 * a message behind a busy agent, and flipping auto-approve all behave the way
 * they will against the server.
 */
export function ChannelPage() {
  const { slug = "backend" } = useParams();
  const narrow = useMediaQuery("(max-width: 900px)");

  const [channels, setChannels] = useState<ChannelView[]>(mockChannels);
  const [agents] = useState<AgentView[]>(mockAgents);
  const [entries, setEntries] = useState<TranscriptEntry[]>(mockTranscript);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<DeliveryMode>("queue");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const channel = channels.find((c) => c.slug === slug) ?? channels[0];
  const knownHandles = useMemo(() => agents.map((a) => a.handle), [agents]);

  /**
   * Posting resolves the mention against the roster and decides, right here,
   * whether the run can be injected now — which is what the queued chip
   * reports. Queue mode waits for `activity === 'idle'`; interrupt does not
   * wait, and says so.
   */
  const send = useCallback(() => {
    const body = draft.trim();
    if (!body) return;
    const handles = mentionedHandles(body);
    const target = agents.find((a) => handles.includes(a.handle.toLowerCase()));
    const willQueue = mode === "queue" && target?.activity === "busy";

    setEntries((current) => [
      ...current,
      {
        kind: "human",
        id: `local_${Date.now()}`,
        seq: current.reduce((max, e) => Math.max(max, e.seq), 0) + 1,
        createdAt: new Date(),
        author: mockCurrentUser,
        body,
        queued:
          willQueue && target
            ? {
                runId: `run_local_${Date.now()}`,
                agentHandle: target.handle,
                reason: target.statusLine ?? "working",
                mode,
              }
            : undefined,
      },
    ]);
    setDraft("");
  }, [agents, draft, mode]);

  const cancelQueued = useCallback((runId: string) => {
    setEntries((current) =>
      current.map((entry) =>
        entry.kind === "human" && entry.queued?.runId === runId
          ? { ...entry, queued: undefined }
          : entry,
      ),
    );
  }, []);

  const resolveDispatch = useCallback(
    (dispatchId: string, decision: "approved" | "denied", prompt?: string) => {
      setEntries((current) =>
        current.map((entry) =>
          entry.kind === "dispatch" && entry.dispatch.id === dispatchId
            ? {
                ...entry,
                dispatch: {
                  ...entry.dispatch,
                  status: decision,
                  decidedByName: mockCurrentUser.name,
                  approvedPrompt:
                    decision === "approved" && prompt && prompt !== entry.dispatch.prompt
                      ? prompt
                      : entry.dispatch.approvedPrompt,
                  runId: decision === "approved" ? `run_${dispatchId}` : null,
                },
              }
            : entry,
        ),
      );
    },
    [],
  );

  /**
   * Flipping auto-approve does three things, and all three are deliberate:
   * it changes the channel, it writes a system message into the transcript
   * (a silent removal of the only human gate is exactly what must not be
   * possible), and it converts any card still on hold into an auto-approved
   * record — the hold goes, the record stays.
   */
  const toggleAutoApprove = useCallback(
    (next: boolean) => {
      setChannels((current) =>
        current.map((c) => (c.id === channel.id ? { ...c, autoApproveDispatch: next } : c)),
      );
      setEntries((current) => {
        const seq = current.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
        const converted = next
          ? current.map((entry) =>
              entry.kind === "dispatch" && entry.dispatch.status === "pending"
                ? {
                    ...entry,
                    dispatch: {
                      ...entry.dispatch,
                      status: "approved" as const,
                      autoApproved: true,
                      decidedByName: null,
                      runId: `run_${entry.dispatch.id}`,
                    },
                  }
                : entry,
            )
          : current;
        return [
          ...converted,
          {
            kind: "system",
            id: `sys_${Date.now()}`,
            seq,
            createdAt: new Date(),
            body: `${mockCurrentUser.name} turned auto-approve ${next ? "on" : "off"} — agent→agent dispatch ${
              next ? "no longer waits for a human" : "requires human approval again"
            }`,
          },
        ];
      });
    },
    [channel.id],
  );

  const sidebar = (
    <ChannelSidebar
      workspace={mockWorkspace}
      channels={channels}
      activeSlug={channel.slug}
      agents={agents}
      currentUser={mockCurrentUser}
      onCreateChannel={() => {
        setDrawerOpen(false);
        setCreateOpen(true);
      }}
      onClose={narrow ? () => setDrawerOpen(false) : undefined}
    />
  );

  return (
    <div
      style={{
        height: "100dvh",
        width: "100%",
        display: "flex",
        background: "var(--ny-bg)",
        color: "var(--ny-text)",
        fontFamily: "var(--ny-font-sans)",
        fontSize: 14,
        overflow: "hidden",
      }}
    >
      <ChannelStyles />

      {/* Wide: a permanent rail. Narrow: a drawer over the transcript, because
          the transcript is the part that has to survive a phone. */}
      {!narrow && sidebar}
      {narrow && drawerOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex" }}>
          <div style={{ height: "100%" }}>{sidebar}</div>
          <button
            type="button"
            aria-label="Close channels"
            onClick={() => setDrawerOpen(false)}
            className="bh-reset"
            style={{ flex: 1, background: "var(--ny-overlay, rgba(0,0,0,.5))", cursor: "pointer" }}
          />
        </div>
      )}

      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
          background: "var(--ny-bg)",
        }}
      >
        <ChannelHeader
          channel={channel}
          onToggleAutoApprove={toggleAutoApprove}
          onOpenSidebar={narrow ? () => setDrawerOpen(true) : undefined}
        />

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <Transcript
            entries={entries}
            knownHandles={knownHandles}
            onApproveDispatch={(id, prompt) => resolveDispatch(id, "approved", prompt)}
            onDenyDispatch={(id) => resolveDispatch(id, "denied")}
            onCancelQueued={cancelQueued}
          />
        </div>

        <Composer
          channelSlug={channel.slug}
          agents={agents}
          value={draft}
          onChange={setDraft}
          mode={mode}
          onModeChange={setMode}
          onSend={send}
        />
      </main>

      <CreateChannelDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={({ slug: newSlug, repo, branch, isPrivate }) => {
          setChannels((current) => [
            ...current,
            {
              id: `chn_${newSlug}`,
              slug: newSlug,
              name: newSlug,
              topic: null,
              gitRepoUrl: repo || null,
              gitBranch: repo ? branch || "main" : null,
              autoApproveDispatch: false,
              isPrivate,
              unreadCount: 0,
              hasMention: false,
              humanCount: 1,
              agentCount: 0,
            },
          ]);
          setCreateOpen(false);
        }}
      />
    </div>
  );
}
