/**
 * Turning an agent's egress policy into container configuration.
 *
 * This is the join between `rules.ts` (what may this agent reach) and
 * `proxy-manager.ts` (the network and proxy that make the answer binding). It
 * is called from `startAgent`, and its output is folded into the `SandboxSpec`.
 *
 * ## Enforcement is not unconditional, and says so
 *
 * `docker_configs.egress_enforce` ships **false**. That is the documented dev
 * escape hatch, and there are two further preconditions that no flag can wish
 * away — see {@link evaluateEnforcement}. When enforcement is off the allowlist
 * is *advisory*: the rules are still resolved, still shown in Settings, and
 * still hash to a policy key, but the agent sits on the ordinary bridge and can
 * reach the internet. The one thing that stays true either way is that
 * `host.docker.internal` is not granted unless the policy is `open` — that
 * costs nothing and closes landmine 6 regardless.
 *
 * The honest failure mode matters here. Silently "enforcing" while an agent has
 * a working route out is the single worst outcome available, so when
 * enforcement is requested and the setup fails, {@link prepareAgentEgress}
 * throws and the agent does not start.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import type { EgressMode } from "./allowlist.js";
import { resolveAgentEgress, type AgentEgressPolicy } from "./rules.js";
import {
  ensureAppOnNetwork,
  ensureEgressNetwork,
  ensureProxyContainer,
  proxyEnvForAgent,
  PROXY_PORT,
} from "./proxy-manager.js";

type AgentRow = typeof schema.agents.$inferSelect;
type BlueprintRow = typeof schema.agentBlueprints.$inferSelect;

export interface EgressAttachment {
  mode: EgressMode;
  policyKey: string;
  /** Canonical effective allowlist, for logging and for the UI. */
  rules: string[];
  /** Is the policy actually binding, or merely advisory? */
  enforced: boolean;
  /** Machine-readable reason when `enforced` is false. */
  reason: EnforcementReason | null;
  /** Docker network the agent attaches to. */
  networkName?: string;
  /** Grant `host.docker.internal` — only ever under `open`. */
  hostGateway: boolean;
  /** Proxy environment (`HTTPS_PROXY` and friends). Empty unless enforced. */
  env: string[];
  /**
   * `/etc/hosts` entries the agent needs to reach the proxy named in `env`.
   *
   * That name is a Docker network alias, resolved by the embedded DNS server —
   * which gVisor sandboxes cannot reach. Without the pin, an enforced agent
   * under runsc cannot resolve its own proxy and every request fails.
   */
  hostAliases: Array<{ host: string; ip: string }>;
}

export type EnforcementReason =
  | "policy-open"
  | "disabled"
  | "host-mode"
  | "unroutable-harness-url"
  | "no-token";

/**
 * Can egress actually be enforced right now? Pure, so the reasoning is
 * testable without a Docker daemon — which is the only way it gets tested,
 * since none exists in CI.
 *
 * Three preconditions, and the last two are not opinions:
 *
 * 1. **The operator opted in.** `docker_configs.egress_enforce`, default false.
 *
 * 2. **Container-network mode.** In host mode the harness reaches an agent's
 *    IDE and browser tabs through a published `127.0.0.1:<ephemeral>` port, and
 *    ports are only published when no Docker network is named
 *    (`toCreateOptions`). Moving the agent onto an internal network in that
 *    mode would break both tabs — and whether loopback publishing works at all
 *    on an `internal: true` network is precisely the thing that has never been
 *    verified on a real host. Refuse rather than guess.
 *
 * 3. **A harness URL the agent can actually resolve from inside the internal
 *    network.** `host.docker.internal` is an `ExtraHosts` alias pointing at the
 *    host gateway; an internal network has no gateway, and we drop that alias
 *    anyway. An agent enforced with that URL would come up unable to reach the
 *    harness at all — no sidecar events, no channel posts. That is a
 *    misconfiguration, not a policy, so it must not masquerade as enforcement.
 */
export function evaluateEnforcement(input: {
  mode: EgressMode;
  egressEnforce: boolean;
  networkName?: string | null;
  blackhouseUrl: string;
}): { enforce: boolean; reason: EnforcementReason | null } {
  if (input.mode === "open") return { enforce: false, reason: "policy-open" };
  if (!input.egressEnforce) return { enforce: false, reason: "disabled" };
  if (!input.networkName) return { enforce: false, reason: "host-mode" };

  const host = harnessHostname(input.blackhouseUrl);
  if (!host || host === "host.docker.internal" || host === "localhost" || host === "127.0.0.1") {
    return { enforce: false, reason: "unroutable-harness-url" };
  }
  return { enforce: true, reason: null };
}

/** Hostname the agent will use to reach the harness, or null if unparseable. */
export function harnessHostname(blackhouseUrl: string): string | null {
  try {
    return new URL(blackhouseUrl).hostname || null;
  } catch {
    return null;
  }
}

/** Read the escape hatch. The env var wins so a dev can flip it without SQL. */
export async function egressEnforceEnabled(): Promise<boolean> {
  const override = process.env.BLACKHOUSE_EGRESS_ENFORCE;
  if (override !== undefined) return /^(1|true|yes|on)$/i.test(override.trim());

  const [config] = await db
    .select()
    .from(schema.dockerConfigs)
    .where(eq(schema.dockerConfigs.id, 1));
  return config?.egressEnforce ?? false;
}

/**
 * Resolve the policy, stand up whatever it needs, and return the container
 * configuration deltas.
 *
 * Throws when enforcement was requested but could not be established. An agent
 * that fails to start is recoverable; an agent that starts believing it is
 * sandboxed when it is not is not.
 */
export async function prepareAgentEgress(
  agent: AgentRow,
  blueprint: BlueprintRow,
  opts: { blackhouseUrl: string; networkName?: string },
): Promise<EgressAttachment> {
  const policy: AgentEgressPolicy = await resolveAgentEgress(agent, blueprint);
  const enforceFlag = await egressEnforceEnabled();

  let { enforce, reason } = evaluateEnforcement({
    mode: policy.mode,
    egressEnforce: enforceFlag,
    networkName: opts.networkName,
    blackhouseUrl: opts.blackhouseUrl,
  });

  // An allowlist agent with no token cannot authenticate to the proxy, so it
  // would be denied everything with a confusing 407 rather than a 403. Treat a
  // missing token as a configuration fault and refuse to pretend.
  if (enforce && policy.mode === "allowlist" && !agent.agentToken) {
    enforce = false;
    reason = "no-token";
  }

  const base: EgressAttachment = {
    mode: policy.mode,
    policyKey: policy.policyKey,
    rules: policy.rules,
    enforced: false,
    reason,
    networkName: opts.networkName,
    // Landmine 6: a host-gateway alias is a direct route to the host and
    // defeats egress control. Granted only under `open`, enforced or not.
    hostGateway: policy.mode === "open",
    env: [],
    hostAliases: [],
  };

  if (!enforce) {
    if (policy.mode !== "open") {
      console.warn(
        `[blackhouse] agent ${agent.handle}: egress policy '${policy.mode}' is ADVISORY ` +
          `(${reason}) — the agent is on the bridge network and can reach the internet. ` +
          `Set docker_configs.egress_enforce = true on a Linux host to enforce it.`,
      );
    }
    return base;
  }

  const harnessHost = harnessHostname(opts.blackhouseUrl)!;
  const networkName = await ensureEgressNetwork(policy.policyKey);

  // Without the harness on this network the agent is unreachable for the IDE
  // and browser tabs, and cannot post events. Failing here is correct.
  const attached = await ensureAppOnNetwork(networkName, [harnessHost, "blackhouse-app"]);
  if (!attached) {
    throw new Error(
      "Egress enforcement is on but the harness could not attach itself to " +
        `${networkName}. The Blackhouse container needs the label ` +
        `blackhouse.role=app and access to the Docker socket.`,
    );
  }

  if (policy.mode === "none") {
    // No proxy, no credentials, no route: an internal network with nothing on
    // it but the agent and the harness.
    return { ...base, enforced: true, reason: null, networkName, env: [], hostAliases: [] };
  }

  const proxy = await ensureProxyContainer({
    policyKey: policy.policyKey,
    rules: policy.rules,
    internalNetwork: networkName,
    bridgeNetwork: opts.networkName!,
    blackhouseUrl: opts.blackhouseUrl,
  });

  const env = proxyEnvForAgent({
    agentId: agent.id,
    agentToken: agent.agentToken!,
    proxyHost: proxy.host,
    proxyPort: PROXY_PORT,
    noProxyHosts: [harnessHost, "blackhouse-app"],
  });

  return {
    ...base,
    enforced: true,
    reason: null,
    networkName,
    env,
    hostAliases: proxy.ip ? [{ host: proxy.host, ip: proxy.ip }] : [],
  };
}
