import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { getDriver, selectDriver } from "../sandbox/registry.js";
import type { SandboxHandle, SandboxSpec } from "../sandbox/types.js";
import { invalidateContainerEndpointCache } from "../lib/docker.js";
import { prepareAgentEgress, type EgressAttachment } from "../egress/attach.js";
import {
  agentDnsServers,
  hasEmbeddedDns,
  mergeHostAliases,
  resolveHostAlias,
} from "./container-dns.js";
import {
  ensureAgentResolvConf,
  needsResolvConfMount,
  resolvConfMount,
} from "./agent-resolv-conf.js";
import { composeSystemPrompt } from "./system-prompt.js";

type AgentRow = typeof schema.agents.$inferSelect;
type BlueprintRow = typeof schema.agentBlueprints.$inferSelect;

/** Browser-service (CDP screencast) and code-server, proxied to the Agent Detail tabs. */
export const AGENT_EXPOSED_PORTS = [9223, 8443];

/** Where the agent CLI keeps its own state (`~/.claude`, sessions, JSONL transcripts). */
export const DEFAULT_STATE_MOUNT_PATH = "/home/workspace";

export function newAgentToken(): string {
  return randomBytes(32).toString("hex");
}

/** Volume names are derived, not stored twice — one source of truth per agent id. */
export function workspaceVolumeName(agentId: string): string {
  return `bh-ws-${agentId}`;
}

export function stateVolumeName(agentId: string): string {
  return `bh-state-${agentId}`;
}

/**
 * The image an agent runs.
 *
 * Pinned per agent when one was built for it, else the blueprint's. Exported
 * because `startAgent` needs the same answer *before* the spec exists — the
 * resolv.conf helper runs that image, and re-deriving the expression there is
 * how the two silently drift apart.
 */
export function agentImage(agent: AgentRow, blueprint: BlueprintRow): string {
  return agent.containerImage || blueprint.image || "";
}

/**
 * Build the sandbox spec for an agent.
 *
 * Two things here are load-bearing and easy to regress:
 *
 * 1. `tty` + `openStdin` must both be true. That pair is what gives the PTY hub
 *    a writable stdin, which is the entire mechanism behind injecting a channel
 *    mention into the agent's live TUI. Without it the product's core feature
 *    silently stops working.
 * 2. The state volume is **per agent**. An earlier iteration mounted one shared
 *    `claude-config` volume into every container, which would have let every
 *    agent read every other agent's `~/.claude/projects` transcripts — and the
 *    sidecar tails exactly that directory.
 */
export function buildAgentSpec(
  agent: AgentRow,
  blueprint: BlueprintRow,
  opts: {
    blackhouseUrl: string;
    networkName?: string;
    /**
     * Egress placement from `server/egress/attach.ts`. When enforcement is on
     * this replaces the network with a policy-scoped `internal: true` one and
     * supplies the proxy environment; when it is off it only confirms the
     * host-gateway decision below.
     */
    egress?: EgressAttachment;
    /**
     * `/etc/hosts` entries for the names the agent must reach — the harness,
     * and the egress proxy when one is in play. Resolved by the caller because
     * it needs a DNS lookup and this function is pure.
     * See `server/agents/container-dns.ts` for why they are needed at all.
     */
    hostAliases?: Array<{ host: string; ip: string }>;
    /** Explicit nameservers; only set where the embedded resolver is unreachable. */
    dns?: string[];
    /**
     * Host path of a resolv.conf to bind over the container's, for runtimes
     * that cannot reach Docker's embedded resolver. Established by the caller
     * because it means talking to the daemon; see
     * `server/agents/agent-resolv-conf.ts` for why it cannot be a local write.
     */
    resolvConfSource?: string;
  } = { blackhouseUrl: "" },
): SandboxSpec {
  const stateMountPath = blueprint.stateMountPath || DEFAULT_STATE_MOUNT_PATH;

  const env: string[] = [
    `BLACKHOUSE_URL=${opts.blackhouseUrl}`,
    `AGENT_ID=${agent.id}`,
    `AGENT_HANDLE=${agent.handle}`,
    `BLACKHOUSE_ADAPTER=${blueprint.cli}`,
  ];
  if (agent.agentToken) env.push(`AGENT_TOKEN=${agent.agentToken}`);
  if (blueprint.agentCommand) env.push(`AGENT_COMMAND=${blueprint.agentCommand}`);

  /**
   * The two heavyweight in-container services, off unless the blueprint asks.
   *
   * Always written, never omitted: `entrypoint.sh` treats an absent flag as
   * "do not start", so an explicit `0` and a missing variable mean the same
   * thing — but sending it explicitly is what keeps an older image talking to a
   * newer server from guessing.
   *
   * code-server is a full VS Code server and the browser service is node plus
   * Playwright plus Chromium, both inside a gVisor sandbox. One agent running
   * both took a 2-CPU host to load average 27.
   */
  env.push(`BLACKHOUSE_ENABLE_IDE=${blueprint.enableIde ? "1" : "0"}`);
  env.push(`BLACKHOUSE_ENABLE_BROWSER=${blueprint.enableBrowser ? "1" : "0"}`);

  /**
   * Always sent, never conditional.
   *
   * This used to be `agent.systemPromptOverride ?? blueprint.systemPrompt`,
   * pushed only when truthy — and since nothing seeds either column, no agent
   * that has ever run received a system prompt at all. An agent asked for an
   * HTML report duly built one and published it to an external artifact service
   * its CLI ships with, because nothing had told it Blackhouse has channels or
   * that `submit-result.sh` is how a human sees anything.
   *
   * `composeSystemPrompt` prepends the harness facts, so the variable is now
   * always non-empty; the entrypoint writes it to a file regardless.
   */
  env.push(
    `SYSTEM_PROMPT=${composeSystemPrompt({
      handle: agent.handle,
      blueprintPrompt: blueprint.systemPrompt,
      agentOverride: agent.systemPromptOverride,
    })}`,
  );
  if (agent.gitRepoUrl) env.push(`GIT_REPO_URL=${agent.gitRepoUrl}`);
  if (agent.gitBranch) env.push(`GIT_BRANCH=${agent.gitBranch}`);

  for (const entry of blueprint.envVars ?? []) {
    env.push(`${entry.key}=${entry.value}`);
  }

  // Proxy variables last, so a blueprint cannot override its own agent's
  // egress by setting `HTTPS_PROXY` in `envVars`. Docker takes the last
  // occurrence of a repeated key.
  env.push(...(opts.egress?.env ?? []));

  const mounts: NonNullable<SandboxSpec["mounts"]> = [
    { source: agent.workspaceVolume, target: "/workspace" },
    { source: agent.stateVolume, target: stateMountPath },
  ];
  for (const mount of blueprint.volumeMounts ?? []) {
    mounts.push({ source: mount.name, target: mount.mountPath });
  }

  // Set only for runtimes that cannot reach Docker's embedded resolver: a
  // real resolv.conf from the Docker host, bind-mounted over the one Docker
  // generates. It is the whole of DNS for a gVisor agent.
  if (opts.resolvConfSource) mounts.push(resolvConfMount(opts.resolvConfSource));

  const egressPolicy = agent.egressPolicy ?? blueprint.egressPolicy;

  return {
    image: agentImage(agent, blueprint),
    env,
    labels: {
      "blackhouse.managed": "true",
      "blackhouse.agent_id": agent.id,
      "blackhouse.agent_handle": agent.handle,
    },
    mounts,
    exposedPorts: AGENT_EXPOSED_PORTS,
    resources: {
      memoryBytes: blueprint.memoryBytes ?? undefined,
      nanoCpus: blueprint.nanoCpus ?? undefined,
      pidsLimit: blueprint.pidsLimit ?? undefined,
    },
    network: {
      // Under enforcement this is the policy-scoped `internal: true` network,
      // which has no gateway — the agent's only way out is the proxy named in
      // the env above. Otherwise it is the ordinary bridge.
      name: opts.egress?.networkName ?? opts.networkName,
      // A host-gateway alias is a direct route to the host and would defeat
      // egress control entirely, so it is only granted under `open`.
      hostGateway: opts.egress?.hostGateway ?? egressPolicy === "open",
      hostAliases: opts.hostAliases,
      dns: opts.dns,
    },
    tty: true,
    openStdin: true,
  };
}

export function handleFor(agent: AgentRow): SandboxHandle | null {
  if (!agent.containerId) return null;
  return {
    id: agent.containerId,
    driver: (agent.runtimeUsed as SandboxHandle["driver"]) ?? "runc",
    image: agent.containerImage ?? undefined,
  };
}

/**
 * Create + start the agent's container, recording which runtime *actually*
 * ran. `runtimeUsed` is stored separately from the requested `sandboxRuntime`
 * on purpose: gVisor is absent on Docker Desktop and Podman, so falling back
 * to runc is the common case, and an invisible fallback would leave someone
 * believing they have isolation they do not have.
 */
export async function startAgent(agentId: string): Promise<AgentRow> {
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  if (!agent) throw new Error("Agent not found");

  /**
   * Whether an agent is running is a question for the runtime, not the row.
   *
   * `agents.status` is only ever written by an action that goes through here,
   * so a container that dies on its own — the CLI exiting because it cannot
   * reach its API, an OOM kill, a daemon restart — leaves the row saying
   * `running` with nothing behind it. The start route trusted that and returned
   * early, which meant the single action that would have recovered the agent
   * was the one action it refused to take. Observed on the deployment: a
   * container in `Exited (1)`, a row reading `running`, and a start button that
   * did nothing at all, twice, silently.
   *
   * A container also binds its image and environment at creation, so the dead
   * one cannot simply be started again — it would come back with exactly the
   * configuration that killed it. It gets removed and rebuilt instead.
   */
  const existing = handleFor(agent);
  if (existing) {
    const inspected = await getDriver(existing.driver)
      .inspect(existing)
      .catch(() => null);

    if (inspected?.running) {
      if (agent.status === "running") return agent;
      const [corrected] = await db
        .update(schema.agents)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(schema.agents.id, agent.id))
        .returning();
      return corrected;
    }

    // Gone or dead. Clear the carcass before building its replacement, so the
    // old container's name does not collide with the new one.
    await getDriver(existing.driver)
      .destroy(existing, { force: true })
      .catch(() => {});
    invalidateContainerEndpointCache(agent.id);
  }

  const [blueprint] = await db
    .select()
    .from(schema.agentBlueprints)
    .where(eq(schema.agentBlueprints.id, agent.blueprintId));
  if (!blueprint) throw new Error("Blueprint not found");

  const requested = agent.sandboxRuntime ?? blueprint.sandboxRuntime;
  const { driver, resolution } = await selectDriver(requested);

  if (resolution.fellBackFrom) {
    console.warn(
      `[blackhouse] agent ${agent.handle}: requested ${resolution.fellBackFrom} runtime, ` +
        `using ${resolution.effective} — ${resolution.reason ?? "runtime unavailable"}`,
    );
  }

  const blackhouseUrl = process.env.BLACKHOUSE_CONTAINER_URL || "http://host.docker.internal:3000";
  const networkName = process.env.BLACKHOUSE_NETWORK;

  // Resolve the egress policy and stand up its network/proxy before the
  // container exists. This throws rather than degrading if enforcement was
  // requested but could not be established — an agent that believes it is
  // sandboxed when it is not is worse than an agent that failed to start.
  const egress = await prepareAgentEgress(agent, blueprint, { blackhouseUrl, networkName });

  // Name resolution, decided per effective runtime. Under gVisor the embedded
  // resolver is unreachable, so the names the agent depends on are pinned into
  // /etc/hosts and everything else is served by the resolv.conf mounted below.
  const hostAliases = mergeHostAliases(egress.hostAliases, [await resolveHostAlias(blackhouseUrl)]);

  /**
   * General name resolution, for runtimes where 127.0.0.11 is unreachable.
   *
   * Pinned `/etc/hosts` entries above cover the names Blackhouse controls; this
   * covers every other name the agent needs, starting with the one that made
   * the bug fatal — the CLI could not reach `api.anthropic.com`, exited, and
   * took the container with it.
   *
   * The mount is applied even under egress enforcement, where the agent sits on
   * an `internal: true` network and reaches the world only through the CONNECT
   * proxy (which resolves on its own side). It changes nothing there — an
   * unreachable 1.1.1.1 fails no worse than an unreachable 127.0.0.11 — and
   * keeping one code path means the enforced case is not a second thing to get
   * right later.
   */
  const resolv = await ensureAgentResolvConf({
    runtime: resolution.effective,
    image: agentImage(agent, blueprint),
  });
  if (resolv.warning) console.warn(`${resolv.warning} (agent ${agent.handle})`);

  /**
   * `HostConfig.Dns` is kept for exactly one case, and it is not the gVisor one.
   *
   * Measured: on a *user-defined* network Docker writes `nameserver 127.0.0.11`
   * regardless and keeps these merely as its own upstreams, so setting it there
   * did nothing at all for a runsc agent — a mitigation that looked like a fix
   * for as long as nobody read the generated resolv.conf. On the host-mode path
   * (no `BLACKHOUSE_NETWORK`, default bridge) Docker does write them verbatim,
   * which is the one place it works, so it is passed there and nowhere else.
   * The user-defined-network case is what the bind mount above is for.
   */
  const onUserDefinedNetwork = Boolean(egress.networkName ?? networkName);
  const dns =
    needsResolvConfMount(resolution.effective) && !resolv.mount && !onUserDefinedNetwork
      ? agentDnsServers()
      : undefined;

  if (!hasEmbeddedDns(resolution.effective) && hostAliases.length === 0) {
    console.warn(
      `[blackhouse] agent ${agent.handle}: running under ${resolution.effective}, where Docker's ` +
        `embedded DNS is unreachable, and the harness URL (${blackhouseUrl}) could not be pinned ` +
        `to an /etc/hosts entry — the sidecar may not be able to report back.`,
    );
  }

  const spec = buildAgentSpec(agent, blueprint, {
    blackhouseUrl,
    networkName,
    egress,
    hostAliases,
    dns,
    resolvConfSource: resolv.mount?.source,
  });

  const handle = await driver.create(spec);
  await driver.start(handle);
  invalidateContainerEndpointCache(agent.id);

  const [updated] = await db
    .update(schema.agents)
    .set({
      containerId: handle.id,
      containerImage: spec.image,
      runtimeUsed: resolution.effective,
      status: "running",
      activity: "unknown",
      updatedAt: new Date(),
    })
    .where(eq(schema.agents.id, agent.id))
    .returning();

  return updated;
}

export async function stopAgent(agentId: string): Promise<AgentRow> {
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  if (!agent) throw new Error("Agent not found");

  const handle = handleFor(agent);
  if (handle) {
    // Stop with the runtime that actually created it, not the requested one —
    // re-resolving could pick a different driver than the container runs under.
    await getDriver(handle.driver)
      .stop(handle)
      .catch(() => {
        // Already gone is a success for our purposes — reconcile on next boot.
      });
  }
  invalidateContainerEndpointCache(agent.id);

  const [updated] = await db
    .update(schema.agents)
    .set({ status: "stopped", activity: "unknown", updatedAt: new Date() })
    .where(eq(schema.agents.id, agent.id))
    .returning();
  return updated;
}

export async function destroyAgent(agentId: string): Promise<void> {
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  if (!agent) return;

  const handle = handleFor(agent);
  if (handle) {
    await getDriver(handle.driver)
      .destroy(handle, { force: true })
      .catch(() => {});
  }
  invalidateContainerEndpointCache(agent.id);

  await db
    .update(schema.agents)
    .set({ status: "destroyed", containerId: null, updatedAt: new Date() })
    .where(eq(schema.agents.id, agent.id));
}
