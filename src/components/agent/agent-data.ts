import type { Agent, AgentCli, EgressPolicy } from "@/db/schema";
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

/**
 * The blueprint behind one agent — `GET /api/agents/:id/blueprint`.
 *
 * A narrow projection rather than the whole row: `GET /api/settings/blueprints`
 * is admin-gated and returns `dockerfileContent`, `envVars` and the rest, and
 * everyone who can open an agent needs to see which blueprint it came from.
 *
 * Replaces `mockBlueprint()`, which hashed the blueprint id into one of three
 * invented names and reported `ui-explorer` for a Claude Code agent.
 */
export interface AgentBlueprint {
  id: string;
  name: string;
  cli: AgentCli;
  image: string | null;
  /**
   * Container caps, in bytes and nano-CPUs. **Nullable, and null is not a
   * default**: an unset cap means the container gets whatever the daemon
   * allows. Rendering a stand-in number here would be the same lie the mock
   * blueprint told, so callers omit the figure instead.
   */
  memoryBytes: number | null;
  nanoCpus: number | null;
  /** Whether the container starts code-server / the browser service at all. */
  enableIde: boolean;
  enableBrowser: boolean;
}

/**
 * The *resolved* egress policy — `GET /api/egress/agents/:id/effective`.
 *
 * Not `agents.egressPolicy`. That column is nullable and null means "inherit
 * the blueprint", so reading it directly reports `inherited` for an agent that
 * in fact gets its blueprint's `open`, and reports the override for an agent
 * whose blueprint is stricter. The server resolves both — and attaches the
 * proxy from this same resolution — so this is the only egress fact worth
 * putting in front of someone.
 */
export interface EffectiveEgress {
  agentId: string;
  mode: EgressPolicy;
  /** Hash of the resolved list; the proxy keys its running config off it. */
  policyKey: string;
  /** The effective host list: `["*"]` for `open`, `[]` for `none`. */
  rules: string[];
  /**
   * Whether this instance enforces egress at all. False means the policy is
   * recorded but no proxy applies it — a restrictive badge over an agent with
   * unrestricted network, which is exactly the misread this pane exists to
   * prevent.
   */
  enforced: boolean;
}

export async function fetchAgentBlueprint(
  agentId: string,
  signal?: AbortSignal,
): Promise<AgentBlueprint> {
  return unwrap<AgentBlueprint>(
    await fetch(`/api/agents/${encodeURIComponent(agentId)}/blueprint`, {
      credentials: "include",
      signal,
    }),
  );
}

export async function fetchEffectiveEgress(
  agentId: string,
  signal?: AbortSignal,
): Promise<EffectiveEgress> {
  return unwrap<EffectiveEgress>(
    await fetch(`/api/egress/agents/${encodeURIComponent(agentId)}/effective`, {
      credentials: "include",
      signal,
    }),
  );
}
