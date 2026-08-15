import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InjectionMode } from "@/db/schema";
import { useChannelStream, type ChannelStreamEvent } from "@/hooks/use-channel-stream";
import { useResource } from "@/hooks/use-resource";
import {
  approveDispatch as approveDispatchRequest,
  createChannel as createChannelRequest,
  denyDispatch as denyDispatchRequest,
  fetchAgentArtifacts,
  fetchAgents,
  fetchChannel,
  fetchChannels,
  fetchDispatches,
  fetchMessages,
  postMessage,
  setAutoApprove as setAutoApproveRequest,
  type CreateChannelInput,
} from "./channel-api";
import {
  mapAgent,
  mapChannel,
  mapTranscript,
  memberCounts,
  type AgentRow,
  type ArtifactRow,
  type ChannelRow,
  type DispatchRow,
  type MessageRow,
  type RunSummary,
} from "./channel-mapping";
import type { AgentView, ChannelView, QueuedView, TranscriptEntry, UserView } from "./types";

/**
 * Everything the Channel View reads and writes, in one hook.
 *
 * The page above it stays a layout: it holds the draft, the delivery mode and
 * two dialogs, and nothing else. Fetching, the single SSE subscription, keyset
 * pagination and optimistic posting all live here, and the mapping they feed is
 * the pure function in `channel-mapping.ts`.
 */

/** How many messages a page asks for — the server's own default. */
const PAGE_SIZE = 50;

/**
 * SSE tells us *that* a message exists, not what it says, so every frame costs
 * a fetch. Sidecar events arrive in bursts (one row per tool call), so the
 * refetch is coalesced instead of fired per frame.
 */
const REFRESH_DEBOUNCE_MS = 150;

/** Ceiling on that coalescing, so a busy agent's steady event stream still
 *  reaches the screen instead of resetting the timer forever. */
const MAX_REFRESH_DELAY_MS = 600;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function newRequestId(): string {
  // `randomUUID` needs a secure context; a plain-HTTP self-hosted instance is a
  // supported deployment, so the fallback is not theoretical.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** A message posted but not yet acknowledged by the server. */
interface PendingMessage {
  requestId: string;
  body: string;
  createdAt: Date;
}

export interface ChannelData {
  channels: ChannelView[];
  channelsLoading: boolean;
  channelsError: string | null;

  /** The channel named by the route, or `null` while loading / when missing. */
  channel: ChannelView | null;
  channelLoading: boolean;
  channelError: string | null;

  agents: AgentView[];
  agentsLoading: boolean;
  agentsError: string | null;

  entries: TranscriptEntry[];
  transcriptLoading: boolean;
  transcriptError: string | null;
  reloadTranscript: () => void;
  /** Re-fetch everything — the retry for a screen that failed before it had a channel. */
  reload: () => void;

  hasMore: boolean;
  loadingMore: boolean;
  loadOlder: () => void;

  /** True while the one multiplexed SSE connection is up. */
  live: boolean;

  /** Resolves false when the post failed; `actionError` carries why. */
  send: (body: string, mode: InjectionMode) => Promise<boolean>;
  approveDispatch: (dispatchId: string, prompt?: string) => Promise<void>;
  denyDispatch: (dispatchId: string) => Promise<void>;
  setAutoApprove: (enabled: boolean) => Promise<void>;
  createChannel: (input: CreateChannelInput) => Promise<ChannelRow | null>;

  /** Last write failure, for the banner above the composer. */
  actionError: string | null;
  clearActionError: () => void;
}

export function useChannelData(slug: string, currentUser: UserView | null): ChannelData {
  // --- Roster and channel list -------------------------------------------

  const channelsResource = useResource<ChannelRow[]>((signal) => fetchChannels(signal), []);
  const agentsResource = useResource<AgentRow[]>((signal) => fetchAgents(signal), []);
  const detailResource = useResource((signal) => fetchChannel(slug, signal), [slug]);

  const [channelRows, setChannelRows] = useState<ChannelRow[]>([]);
  const [agents, setAgents] = useState<AgentView[]>([]);

  useEffect(() => {
    if (channelsResource.data) setChannelRows(channelsResource.data);
  }, [channelsResource.data]);

  useEffect(() => {
    if (agentsResource.data) setAgents(agentsResource.data.map(mapAgent));
  }, [agentsResource.data]);

  const detail = detailResource.data;
  const counts = useMemo(() => memberCounts(detail?.members), [detail]);

  const channel = useMemo<ChannelView | null>(() => {
    // The detail response is authoritative (it carries the member list); the
    // list response is what makes the header render before it lands.
    if (detail && detail.slug === slug) return mapChannel(detail, counts);
    const row = channelRows.find((c) => c.slug === slug);
    return row ? mapChannel(row) : null;
  }, [detail, slug, counts, channelRows]);

  const channelId = channel?.id ?? null;

  const channels = useMemo(
    () =>
      channelRows.map((row) =>
        // Keep the active channel's live auto-approve state in the rail too, so
        // the badge and the list never disagree after a toggle.
        row.slug === slug && channel ? channel : mapChannel(row),
      ),
    [channelRows, slug, channel],
  );

  // --- Transcript ---------------------------------------------------------

  const [rows, setRows] = useState<MessageRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [transcriptLoading, setTranscriptLoading] = useState(true);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [queued, setQueued] = useState<Record<string, QueuedView>>({});
  const [runs, setRuns] = useState<Record<string, RunSummary>>({});
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactRow>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * Bumped on every channel change so an in-flight response for the channel
   * you just left cannot land in the channel you just opened.
   */
  const generation = useRef(0);

  const mergeRows = useCallback((incoming: MessageRow[]) => {
    if (incoming.length === 0) return;
    setRows((prev) => {
      const byId = new Map(prev.map((row) => [row.id, row]));
      for (const row of incoming) byId.set(row.id, row);
      return [...byId.values()];
    });
    // Reconciliation: a real row carrying our `requestId` *is* the optimistic
    // row, so drop the local copy. Doing it here rather than only in `send`
    // covers the case where the SSE refetch beats the POST response back.
    const acknowledged = new Set(
      incoming.map((row) => row.requestId).filter((id): id is string => Boolean(id)),
    );
    if (acknowledged.size > 0) {
      setPending((prev) => prev.filter((item) => !acknowledged.has(item.requestId)));
    }
  }, []);

  // First page, and a full reset whenever the channel changes.
  useEffect(() => {
    if (!slug) return;
    generation.current += 1;
    const mine = generation.current;
    const controller = new AbortController();

    setRows([]);
    setPending([]);
    setQueued({});
    setCursor(null);
    setHasMore(false);
    setTranscriptError(null);
    setTranscriptLoading(true);

    fetchMessages(slug, { limit: PAGE_SIZE, signal: controller.signal })
      .then((page) => {
        if (mine !== generation.current) return;
        setRows(page.messages);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
        setTranscriptError(null);
      })
      .catch((err: unknown) => {
        if (mine !== generation.current || controller.signal.aborted) return;
        // An error must never look like an empty channel: the transcript
        // renders the failure, and "nothing was said" stays a distinct state.
        setTranscriptError(errorText(err));
      })
      .finally(() => {
        if (mine === generation.current) setTranscriptLoading(false);
      });

    return () => controller.abort();
  }, [slug, reloadNonce]);

  const loadOlder = useCallback(() => {
    if (!cursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    // The cursor goes back verbatim. It is `(createdAt, id)`, so rows appended
    // while you scroll shift nothing — which an offset would not survive.
    fetchMessages(slug, { limit: PAGE_SIZE, before: cursor })
      .then((page) => {
        if (mine !== generation.current) return;
        mergeRows(page.messages);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      })
      .catch((err: unknown) => {
        if (mine === generation.current) setActionError(errorText(err));
      })
      .finally(() => {
        if (mine === generation.current) setLoadingMore(false);
      });
  }, [cursor, loadingMore, slug, mergeRows]);

  /**
   * Pull the newest page and merge it. Used for every live update, because SSE
   * carries ids rather than rows. It deliberately does not touch `cursor` or
   * `hasMore` — those describe how far *back* we have read.
   */
  const refreshTimer = useRef<number | null>(null);
  const refreshDeadline = useRef(0);

  const refreshNewest = useCallback(() => {
    const now = Date.now();
    if (refreshTimer.current === null) {
      refreshDeadline.current = now + MAX_REFRESH_DELAY_MS;
    } else if (now + REFRESH_DEBOUNCE_MS > refreshDeadline.current) {
      // A continuous burst must not starve the refresh forever: past the
      // deadline, let the already-scheduled fetch fire instead of pushing it.
      return;
    } else {
      window.clearTimeout(refreshTimer.current);
    }

    // Captured at *schedule* time, not fire time. Without this, a frame that
    // arrives just before you switch channels lands a page from the channel
    // you left into the channel you opened.
    const mine = generation.current;
    const key = slug;

    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      if (mine !== generation.current) return;
      fetchMessages(key, { limit: PAGE_SIZE })
        .then((page) => {
          if (mine !== generation.current) return;
          mergeRows(page.messages);
          setTranscriptError(null);
        })
        .catch(() => {
          // A failed background refresh is not worth replacing a readable
          // transcript with an error; the next frame retries.
        });
    }, REFRESH_DEBOUNCE_MS);
  }, [slug, mergeRows]);

  useEffect(
    () => () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    },
    [],
  );

  // --- Dispatch rows ------------------------------------------------------

  const dispatchesResource = useResource<DispatchRow[]>((signal) => fetchDispatches(signal), []);
  const [dispatchRows, setDispatchRows] = useState<DispatchRow[]>([]);

  useEffect(() => {
    if (dispatchesResource.data) setDispatchRows(dispatchesResource.data);
  }, [dispatchesResource.data]);

  const reloadDispatches = useCallback(async () => {
    const mine = generation.current;
    const fresh = await fetchDispatches().catch(() => null);
    if (fresh && mine === generation.current) setDispatchRows(fresh);
  }, []);

  const dispatches = useMemo(
    () => Object.fromEntries(dispatchRows.map((row) => [row.id, row])),
    [dispatchRows],
  );

  // --- Artifact enrichment ------------------------------------------------

  // `messages.body` already gives an artifact card its title, so this only adds
  // kind and size. Attempts are remembered so a missing artifact (deleted, or
  // past the agent's 50-row window) is not re-fetched on every render.
  const attemptedArtifacts = useRef(new Set<string>());

  useEffect(() => {
    const missing = rows.filter((row) => {
      if (row.kind !== "artifact") return false;
      const id = row.metadata?.artifactId;
      return typeof id === "string" && !attemptedArtifacts.current.has(id);
    });
    if (missing.length === 0) return;

    for (const row of missing) attemptedArtifacts.current.add(String(row.metadata?.artifactId));
    const agentIds = [
      ...new Set(missing.map((row) => row.authorAgentId).filter((id): id is string => Boolean(id))),
    ];
    if (agentIds.length === 0) return;

    let live = true;
    void Promise.all(agentIds.map((id) => fetchAgentArtifacts(id).catch(() => []))).then(
      (lists) => {
        if (!live) return;
        const flat = lists.flat();
        if (flat.length === 0) return;
        setArtifacts((prev) => {
          const next = { ...prev };
          for (const artifact of flat) next[artifact.id] = artifact;
          return next;
        });
      },
    );
    return () => {
      live = false;
    };
  }, [rows]);

  // --- The one SSE subscription -------------------------------------------

  const onStreamEvent = useCallback(
    (event: ChannelStreamEvent) => {
      switch (event.type) {
        case "message.created":
        case "message.updated":
          if (!channelId || event.channelId === channelId) refreshNewest();
          break;

        case "agent.status":
          setAgents((prev) =>
            prev.map((agent) =>
              agent.id === event.agentId
                ? {
                    ...agent,
                    status: event.status as AgentView["status"],
                    activity: event.activity as AgentView["activity"],
                  }
                : agent,
            ),
          );
          break;

        case "agent.status_line":
          setAgents((prev) =>
            prev.map((agent) =>
              agent.id === event.agentId ? { ...agent, statusLine: event.statusLine } : agent,
            ),
          );
          break;

        case "run.updated": {
          const status = event.status as RunSummary["status"];
          setRuns((prev) => ({
            ...prev,
            [event.runId]: { ...prev[event.runId], id: event.runId, status },
          }));
          // The chip says "waiting"; once the run leaves the queue it is no
          // longer waiting, and a chip that outlives its run is a lie.
          if (status !== "queued") {
            setQueued((prev) => {
              const next: Record<string, QueuedView> = {};
              for (const [messageId, view] of Object.entries(prev)) {
                if (view.runId !== event.runId) next[messageId] = view;
              }
              return next;
            });
          }
          break;
        }

        case "dispatch.updated":
          if (!channelId || event.channelId === channelId) {
            void reloadDispatches();
            refreshNewest();
          }
          break;
      }
    },
    [channelId, refreshNewest, reloadDispatches],
  );

  const topics = useMemo(
    () => (channelId ? ["workspace", `channel:${channelId}`] : ["workspace"]),
    [channelId],
  );
  const { connected } = useChannelStream(topics, onStreamEvent);

  // --- Writes -------------------------------------------------------------

  const send = useCallback(
    async (body: string, mode: InjectionMode): Promise<boolean> => {
      const trimmed = body.trim();
      if (!trimmed) return false;
      const requestId = newRequestId();
      const mine = generation.current;

      setActionError(null);
      setPending((prev) => [...prev, { requestId, body: trimmed, createdAt: new Date() }]);

      try {
        const result = await postMessage(slug, { body: trimmed, mode, requestId });
        if (mine !== generation.current) return true;

        mergeRows([result.message]);
        setPending((prev) => prev.filter((item) => item.requestId !== requestId));

        // The queue/interrupt verdict is the *server's*, not ours: it is the
        // only side that knows whether the agent is busy, stopped or paused,
        // and those three read very differently. The reason travels verbatim.
        const outcome = result.dispatched.find((item) => item.queued);
        if (outcome) {
          const agent = agents.find((item) => item.id === outcome.agentId);
          setQueued((prev) => ({
            ...prev,
            [result.message.id]: {
              runId: outcome.runId,
              agentHandle: agent?.handle ?? "agent",
              reason: outcome.reason ?? "waiting to be delivered",
              mode,
            },
          }));
        }
        for (const item of result.dispatched) {
          setRuns((prev) => ({
            ...prev,
            [item.runId]: {
              ...prev[item.runId],
              id: item.runId,
              status: item.queued ? "queued" : "running",
            },
          }));
        }
        return true;
      } catch (err) {
        if (mine === generation.current) {
          setPending((prev) => prev.filter((item) => item.requestId !== requestId));
          setActionError(errorText(err));
        }
        return false;
      }
    },
    [slug, agents, mergeRows],
  );

  const approveDispatch = useCallback(
    async (dispatchId: string, prompt?: string) => {
      setActionError(null);
      try {
        await approveDispatchRequest(dispatchId, prompt);
        await reloadDispatches();
        refreshNewest();
      } catch (err) {
        setActionError(errorText(err));
      }
    },
    [reloadDispatches, refreshNewest],
  );

  const denyDispatch = useCallback(
    async (dispatchId: string) => {
      setActionError(null);
      try {
        await denyDispatchRequest(dispatchId);
        await reloadDispatches();
        refreshNewest();
      } catch (err) {
        setActionError(errorText(err));
      }
    },
    [reloadDispatches, refreshNewest],
  );

  const setAutoApprove = useCallback(
    async (enabled: boolean) => {
      setActionError(null);
      try {
        const updated = await setAutoApproveRequest(slug, enabled);
        setChannelRows((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
        detailResource.set(detail ? { ...detail, ...updated } : { ...updated, members: [] });
        // The server writes a system message recording the flip; it arrives on
        // the stream, but pull it in immediately so the record is visible even
        // if the stream is down.
        refreshNewest();
      } catch (err) {
        setActionError(errorText(err));
      }
    },
    [slug, detail, detailResource, refreshNewest],
  );

  const createChannel = useCallback(
    async (input: CreateChannelInput): Promise<ChannelRow | null> => {
      setActionError(null);
      try {
        const created = await createChannelRequest(input);
        setChannelRows((prev) => [...prev, created].sort((a, b) => a.slug.localeCompare(b.slug)));
        return created;
      } catch (err) {
        setActionError(errorText(err));
        return null;
      }
    },
    [],
  );

  // --- Projection ---------------------------------------------------------

  const entries = useMemo(() => {
    const maxSeq = rows.reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0);
    const optimistic: MessageRow[] = pending.map((item, index) => ({
      id: `pending:${item.requestId}`,
      seq: maxSeq + 1 + index,
      authorKind: "user",
      authorUserId: currentUser?.id ?? null,
      kind: "text",
      body: item.body,
      requestId: item.requestId,
      createdAt: item.createdAt,
    }));

    return mapTranscript({
      messages: [...rows, ...optimistic],
      agents,
      currentUser,
      dispatches,
      runs,
      artifacts,
      queued,
    });
  }, [rows, pending, currentUser, agents, dispatches, runs, artifacts, queued]);

  return {
    channels,
    channelsLoading: channelsResource.loading,
    channelsError: channelsResource.error,

    channel,
    channelLoading: detailResource.loading && !channel,
    channelError: detailResource.error,

    agents,
    agentsLoading: agentsResource.loading,
    agentsError: agentsResource.error,

    entries,
    transcriptLoading,
    transcriptError,
    reloadTranscript: useCallback(() => setReloadNonce((n) => n + 1), []),
    // `reload` on each resource is a stable `useCallback`, so this identity
    // only changes when a resource is genuinely replaced.
    reload: useCallback(() => {
      channelsResource.reload();
      agentsResource.reload();
      detailResource.reload();
      dispatchesResource.reload();
      setReloadNonce((n) => n + 1);
    }, [
      channelsResource.reload,
      agentsResource.reload,
      detailResource.reload,
      dispatchesResource.reload,
    ]),

    hasMore,
    loadingMore,
    loadOlder,

    live: connected,

    send,
    approveDispatch,
    denyDispatch,
    setAutoApprove,
    createChannel,

    actionError,
    clearActionError: useCallback(() => setActionError(null), []),
  };
}
