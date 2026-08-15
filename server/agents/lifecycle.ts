import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { getDriver, selectDriver } from "../sandbox/registry.js";
import type { SandboxHandle, SandboxSpec } from "../sandbox/types.js";
import { invalidateContainerEndpointCache } from "../lib/docker.js";

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
  opts: { blackhouseUrl: string; networkName?: string } = { blackhouseUrl: "" },
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

  const systemPrompt = agent.systemPromptOverride ?? blueprint.systemPrompt;
  if (systemPrompt) env.push(`SYSTEM_PROMPT=${systemPrompt}`);
  if (agent.gitRepoUrl) env.push(`GIT_REPO_URL=${agent.gitRepoUrl}`);
  if (agent.gitBranch) env.push(`GIT_BRANCH=${agent.gitBranch}`);

  for (const entry of blueprint.envVars ?? []) {
    env.push(`${entry.key}=${entry.value}`);
  }

  const mounts: NonNullable<SandboxSpec["mounts"]> = [
    { source: agent.workspaceVolume, target: "/workspace" },
    { source: agent.stateVolume, target: stateMountPath },
  ];
  for (const mount of blueprint.volumeMounts ?? []) {
    mounts.push({ source: mount.name, target: mount.mountPath });
  }

  const egressPolicy = agent.egressPolicy ?? blueprint.egressPolicy;

  return {
    image: agent.containerImage || blueprint.image || "",
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
      name: opts.networkName,
      // A host-gateway alias is a direct route to the host and would defeat
      // egress control entirely, so it is only granted under `open`.
      hostGateway: egressPolicy === "open",
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

  const spec = buildAgentSpec(agent, blueprint, {
    blackhouseUrl: process.env.BLACKHOUSE_CONTAINER_URL || "http://host.docker.internal:3000",
    networkName: process.env.BLACKHOUSE_NETWORK,
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
