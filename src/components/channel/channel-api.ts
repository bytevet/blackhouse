/**
 * The Channel View's HTTP surface.
 *
 * Plain `fetch` rather than the `hono/client` RPC wrapper, and the reason is
 * concrete: the channel and dispatch routes parse their bodies by hand
 * (`await c.req.json()` + `safeParse`) instead of going through `zValidator`,
 * so hono infers no request type for them and `$post({ json })` does not
 * type-check. `unwrap`/`ApiError` from `@/lib/api` are still used, so failures
 * surface with a status code the UI can act on.
 */

import { ApiError } from "@/lib/api";
import type { InjectionMode } from "@/db/schema";
import type {
  AgentRow,
  ArtifactRow,
  ChannelMemberRow,
  ChannelRow,
  DispatchRow,
  MessageRow,
} from "./channel-mapping";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: init.body ? { "Content-Type": "application/json", ...init.headers } : init.headers,
  });

  if (!response.ok) {
    // The API answers errors as `{ error }`; fall back to the raw text so a
    // proxy's HTML error page still reaches the user as *something*.
    const text = await response.text().catch(() => response.statusText);
    let message = text || response.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* not JSON — keep the raw text */
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

// --- Channels -------------------------------------------------------------

export function fetchChannels(signal?: AbortSignal): Promise<ChannelRow[]> {
  return request<ChannelRow[]>("/api/channels", { signal });
}

export type ChannelDetail = ChannelRow & { members: ChannelMemberRow[] };

export function fetchChannel(key: string, signal?: AbortSignal): Promise<ChannelDetail> {
  return request<ChannelDetail>(`/api/channels/${encodeURIComponent(key)}`, { signal });
}

export interface CreateChannelInput {
  slug: string;
  gitRepoUrl?: string | null;
  gitBranch?: string | null;
  isPrivate?: boolean;
}

export function createChannel(input: CreateChannelInput): Promise<ChannelRow> {
  return request<ChannelRow>("/api/channels", { method: "POST", ...json(input) });
}

// --- Members ---------------------------------------------------------------

/** A human in a channel, as the members dialog renders them. */
export interface ChannelPerson {
  memberId: string;
  id: string;
  name: string;
  email: string;
  /** Workspace role — `admin`, or null for an ordinary member. */
  role: string | null;
}

/** An agent in a channel. Carries both state signals, like every other surface. */
export interface ChannelAgentMember {
  memberId: string;
  id: string;
  handle: string;
  displayName: string;
  status: string;
  activity: string;
  statusLine: string | null;
}

export interface ChannelMembers {
  people: ChannelPerson[];
  agents: ChannelAgentMember[];
}

export function fetchChannelMembers(key: string, signal?: AbortSignal): Promise<ChannelMembers> {
  return request<ChannelMembers>(`/api/channels/${encodeURIComponent(key)}/members`, { signal });
}

export interface MemberCandidates {
  people: Array<{ id: string; name: string; email: string }>;
  agents: Array<{ id: string; handle: string; displayName: string }>;
}

export function fetchMemberCandidates(
  key: string,
  signal?: AbortSignal,
): Promise<MemberCandidates> {
  return request<MemberCandidates>(`/api/channels/${encodeURIComponent(key)}/members/candidates`, {
    signal,
  });
}

export function addChannelMember(
  key: string,
  input: { userId: string } | { agentId: string },
): Promise<unknown> {
  return request(`/api/channels/${encodeURIComponent(key)}/members`, {
    method: "POST",
    ...json(input),
  });
}

export function removeChannelMember(key: string, memberId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/channels/${encodeURIComponent(key)}/members/${encodeURIComponent(memberId)}`,
    { method: "DELETE" },
  );
}

export function setAutoApprove(key: string, enabled: boolean): Promise<ChannelRow> {
  return request<ChannelRow>(`/api/channels/${encodeURIComponent(key)}/auto-approve`, {
    method: "PUT",
    ...json({ enabled }),
  });
}

/**
 * `owner/repo` → a real URL, because the server validates `gitRepoUrl` with
 * `z.string().url()` while the create dialog asks for the short form. Anything
 * that is neither is dropped rather than sent — a 400 on channel creation
 * because of an optional field would be baffling.
 */
export function normaliseRepoUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return `https://github.com/${value}`;
  return null;
}

// --- Transcript -----------------------------------------------------------

export interface MessagePage {
  /** Newest first, as the keyset endpoint returns them. */
  messages: MessageRow[];
  hasMore: boolean;
  /** `<ISO>,<id>` — opaque. Pass it back verbatim as `before`. */
  nextCursor: string | null;
}

export function fetchMessages(
  key: string,
  options: { limit?: number; before?: string | null; signal?: AbortSignal } = {},
): Promise<MessagePage> {
  const query = new URLSearchParams();
  if (options.limit) query.set("limit", String(options.limit));
  // Verbatim: the cursor is `(createdAt, id)` and re-encoding it as an offset
  // double-renders rows in a channel that appends while you scroll.
  if (options.before) query.set("before", options.before);
  const suffix = query.toString() ? `?${query}` : "";
  return request<MessagePage>(
    `/api/channels/${encodeURIComponent(key)}/messages${suffix}`,
    options.signal ? { signal: options.signal } : {},
  );
}

/** One entry of the post response's `dispatched[]` — the server's routing verdict. */
export interface DispatchOutcome {
  agentId: string;
  runId: string;
  queued: boolean;
  /** Why it was queued, in the server's words. Distinguishes "busy" from "not
   *  running" from "paused", which read very differently to a user. */
  reason?: string;
}

export interface PostMessageResult {
  message: MessageRow;
  dispatched: DispatchOutcome[];
  /**
   * Handles that were mentioned but are not in this channel, so nothing was
   * dispatched to them. The message still posted — losing what someone typed
   * over a membership detail would be worse than telling them about it.
   */
  notMembers?: string[];
}

export function postMessage(
  key: string,
  input: { body: string; mode: InjectionMode; requestId: string },
): Promise<PostMessageResult> {
  return request<PostMessageResult>(`/api/channels/${encodeURIComponent(key)}/messages`, {
    method: "POST",
    ...json(input),
  });
}

// --- Agents & dispatches --------------------------------------------------

export function fetchAgents(signal?: AbortSignal): Promise<AgentRow[]> {
  return request<AgentRow[]>("/api/agents", { signal });
}

export function fetchAgentArtifacts(agentId: string, signal?: AbortSignal): Promise<ArtifactRow[]> {
  return request<ArtifactRow[]>(`/api/agents/${encodeURIComponent(agentId)}/artifacts`, { signal });
}

/**
 * Artifact metadata for the cards in one channel.
 *
 * Replaces asking every agent in the transcript for its own last 50 artifacts
 * and merging the answers: that was one request per author, it returned rows
 * from other channels, and it silently missed anything that had scrolled out
 * of an agent's window. Artifacts belong to a channel, so ask the channel.
 */
export function fetchChannelArtifacts(
  key: string,
  ids: string[],
  signal?: AbortSignal,
): Promise<ArtifactRow[]> {
  const query = ids.length > 0 ? `?ids=${encodeURIComponent(ids.join(","))}` : "";
  return request<ArtifactRow[]>(`/api/channels/${encodeURIComponent(key)}/artifacts${query}`, {
    signal,
  });
}

export function fetchDispatches(signal?: AbortSignal): Promise<DispatchRow[]> {
  return request<DispatchRow[]>("/api/dispatches", { signal });
}

export function approveDispatch(id: string, prompt?: string): Promise<{ runId?: string }> {
  return request<{ runId?: string }>(`/api/dispatches/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    ...json(prompt ? { prompt } : {}),
  });
}

export function denyDispatch(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/dispatches/${encodeURIComponent(id)}/deny`, {
    method: "POST",
    ...json({}),
  });
}
