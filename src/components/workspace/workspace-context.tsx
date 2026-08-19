import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useChannelStream, type ChannelStreamEvent } from "@/hooks/use-channel-stream";
import { useResource } from "@/hooks/use-resource";
import {
  createChannel as createChannelRequest,
  fetchAgents,
  fetchChannels,
  type CreateChannelInput,
} from "@/components/channel/channel-api";
import {
  mapAgent,
  mapChannel,
  type AgentRow,
  type ChannelRow,
} from "@/components/channel/channel-mapping";
import type { AgentView, ChannelView } from "@/components/channel/types";

/**
 * Workspace-wide state: the channel list, the agent roster, and the one
 * EventSource the whole tab shares.
 *
 * This exists because the sidebar outlived the page it used to belong to. It
 * now renders on every route in `AppShell`, so the data behind it cannot live
 * in `useChannelData` — a channel page that unmounts when you open an agent
 * would take the roster with it.
 *
 * **The stream is the reason this is a provider and not a plain hook.**
 * `GET /api/stream` is multiplexed by topic precisely so a tab opens one
 * connection rather than one per room, and browsers cap concurrent connections
 * to an origin at around six. Lifting the roster while leaving the channel page
 * its own `useChannelStream` would have quietly made it two — invisible in
 * development, permanent in production. So the provider owns the single
 * subscription and rooms attach to it through `useStreamTopic` below.
 *
 * The roster events (`agent.status`, `agent.status_line`) are handled here
 * rather than fanned out, because the roster is this module's own state.
 * Everything else is broadcast to whoever is listening.
 */

export interface WorkspaceData {
  channels: ChannelView[];
  channelsLoading: boolean;
  channelsError: string | null;

  agents: AgentView[];
  agentsLoading: boolean;
  agentsError: string | null;

  /** True while the shared SSE connection is up. */
  live: boolean;

  /** Resolves null when the create failed; `actionError` carries why. */
  createChannel: (input: CreateChannelInput) => Promise<ChannelRow | null>;
  /**
   * Patch one channel row in place after a write that changed it.
   *
   * Without this the rail keeps a stale copy: the channel page's own detail
   * fetch is authoritative for the open room, but leaving on a stale row and
   * coming back shows the pre-write state until the next full reload.
   */
  applyChannel: (row: ChannelRow) => void;
  /** Re-fetch the channel list and roster — the retry for a rail that failed. */
  reload: () => void;

  /** Last workspace-level write failure, for the shell to surface. */
  actionError: string | null;
  clearActionError: () => void;

  /**
   * Attach a topic and a handler to the shared stream. Called by
   * `useStreamTopic`; components should use that instead.
   */
  attach: (topic: string | null, handler: StreamHandler) => () => void;
}

type StreamHandler = (event: ChannelStreamEvent) => void;

const WorkspaceContext = createContext<WorkspaceData | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const channelsResource = useResource<ChannelRow[]>((signal) => fetchChannels(signal), []);
  const agentsResource = useResource<AgentRow[]>((signal) => fetchAgents(signal), []);

  const [channelRows, setChannelRows] = useState<ChannelRow[]>([]);
  const [agents, setAgents] = useState<AgentView[]>([]);

  useEffect(() => {
    if (channelsResource.data) setChannelRows(channelsResource.data);
  }, [channelsResource.data]);

  useEffect(() => {
    if (agentsResource.data) setAgents(agentsResource.data.map(mapAgent));
  }, [agentsResource.data]);

  // --- The shared subscription -------------------------------------------

  /**
   * Topics are ref-counted. Two components asking for the same topic must not
   * make the second unsubscribe undo the first, and a channel→agent→channel
   * walk must not churn the connection when the topic set is unchanged.
   */
  const topicCounts = useRef(new Map<string, number>());
  const [extraTopics, setExtraTopics] = useState<string[]>([]);
  const handlers = useRef(new Set<StreamHandler>());

  const attach = useCallback((topic: string | null, handler: StreamHandler) => {
    handlers.current.add(handler);

    if (topic) {
      const counts = topicCounts.current;
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
      setExtraTopics([...counts.keys()]);
    }

    return () => {
      handlers.current.delete(handler);
      if (!topic) return;
      const counts = topicCounts.current;
      const next = (counts.get(topic) ?? 1) - 1;
      if (next <= 0) counts.delete(topic);
      else counts.set(topic, next);
      setExtraTopics([...counts.keys()]);
    };
  }, []);

  const onEvent = useCallback((event: ChannelStreamEvent) => {
    // The roster is this module's state, so it is updated here rather than
    // pushed at subscribers who would each have to know how to apply it.
    switch (event.type) {
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
    }

    // Every frame still reaches the rooms: an agent going idle is roster state
    // *and* something the open channel may want to react to.
    for (const handler of handlers.current) handler(event);
  }, []);

  const topics = useMemo(() => ["workspace", ...extraTopics], [extraTopics]);
  const { connected } = useChannelStream(topics, onEvent);

  // --- Writes -------------------------------------------------------------

  const [actionError, setActionError] = useState<string | null>(null);

  const createChannel = useCallback(
    async (input: CreateChannelInput): Promise<ChannelRow | null> => {
      setActionError(null);
      try {
        const created = await createChannelRequest(input);
        setChannelRows((prev) => [...prev, created].sort((a, b) => a.slug.localeCompare(b.slug)));
        return created;
      } catch (err) {
        // A failed create must not close the dialog silently — the caller
        // checks for null and the shell renders this message.
        setActionError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [],
  );

  const applyChannel = useCallback((row: ChannelRow) => {
    setChannelRows((prev) => prev.map((c) => (c.id === row.id ? { ...c, ...row } : c)));
  }, []);

  const reloadChannels = channelsResource.reload;
  const reloadAgents = agentsResource.reload;
  const reload = useCallback(() => {
    reloadChannels();
    reloadAgents();
  }, [reloadChannels, reloadAgents]);

  const channels = useMemo(() => channelRows.map((row) => mapChannel(row)), [channelRows]);

  const value = useMemo<WorkspaceData>(
    () => ({
      channels,
      channelsLoading: channelsResource.loading,
      channelsError: channelsResource.error,
      agents,
      agentsLoading: agentsResource.loading,
      agentsError: agentsResource.error,
      live: connected,
      createChannel,
      applyChannel,
      reload,
      actionError,
      clearActionError: () => setActionError(null),
      attach,
    }),
    [
      channels,
      channelsResource.loading,
      channelsResource.error,
      agents,
      agentsResource.loading,
      agentsResource.error,
      connected,
      createChannel,
      applyChannel,
      reload,
      actionError,
      attach,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceData {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return value;
}

/**
 * Subscribe to the shared stream for as long as this component is mounted,
 * optionally adding a topic to the connection.
 *
 * Use this rather than `useChannelStream` directly. A second EventSource would
 * work, look correct locally, and cost every user one of their handful of
 * per-origin connections for the life of the tab.
 */
export function useStreamTopic(topic: string | null, handler: StreamHandler): void {
  const { attach } = useWorkspace();

  // The handler closes over state and changes most renders. Keeping it in a ref
  // means a re-render never detaches and re-attaches the subscription — which
  // for a topic-carrying subscriber would rebuild the EventSource.
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => attach(topic, (event) => ref.current(event)), [attach, topic]);
}
