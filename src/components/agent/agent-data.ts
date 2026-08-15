import type { Agent } from "@/db/schema";
import { unwrap } from "@/lib/api";

/**
 * Client-side view of an agent, and the four lifecycle calls Agent Detail
 * makes against `server/api/agents.ts`.
 *
 * Plain `fetch` rather than the `hc<AppType>` client in `src/lib/api.ts`: the
 * typed client resolves `AppType` across the whole server, which is mid-port
 * to the harness model. Coupling this page's compile to that is a false
 * dependency — the routes here are four fixed URLs. `unwrap` is still reused
 * so failures surface as `ApiError` with the server's message, exactly as
 * everywhere else in the app.
 */

/** `Date` becomes a string once it has been through `JSON.stringify`. */
type Jsonify<T> = T extends Date ? string : T;

/**
 * What `GET /api/agents/:id` actually returns.
 *
 * `agentToken` is omitted at the type level because the server strips it
 * deliberately (`toAgentSummary`) — it is the container's bearer credential.
 * Typing it as present would invite a component to render it.
 */
export type AgentDetail = {
  [K in keyof Omit<Agent, "agentToken">]: Jsonify<Agent[K]>;
};

/** Shape of `GET /api/agents/runtimes` (`RuntimeAvailability` on the server). */
export interface RuntimeAvailability {
  /** Runtime names the daemon has registered, e.g. `["runc", "runsc"]`. */
  runtimes: string[];
  /** The daemon's default runtime. */
  defaultRuntime: string;
  /** When the snapshot was taken (ms epoch). */
  detectedAt: number;
}

const json = { "content-type": "application/json" };

export async function fetchAgent(agentId: string, signal?: AbortSignal): Promise<AgentDetail> {
  return unwrap<AgentDetail>(
    await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
      credentials: "include",
      signal,
    }),
  );
}

export async function fetchRuntimes(signal?: AbortSignal): Promise<RuntimeAvailability> {
  return unwrap<RuntimeAvailability>(
    await fetch("/api/agents/runtimes", { credentials: "include", signal }),
  );
}

export async function startAgent(agentId: string): Promise<AgentDetail> {
  return unwrap<AgentDetail>(
    await fetch(`/api/agents/${encodeURIComponent(agentId)}/start`, {
      method: "POST",
      credentials: "include",
      headers: json,
    }),
  );
}

export async function stopAgent(agentId: string): Promise<AgentDetail> {
  return unwrap<AgentDetail>(
    await fetch(`/api/agents/${encodeURIComponent(agentId)}/stop`, {
      method: "POST",
      credentials: "include",
      headers: json,
    }),
  );
}

export async function destroyAgent(agentId: string): Promise<void> {
  await unwrap<{ ok: true }>(
    await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
      credentials: "include",
    }),
  );
}
