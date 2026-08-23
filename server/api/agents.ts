import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { streamBus } from "../lib/stream-bus.js";
import * as schema from "../db/schema.js";
import { authMiddleware, adminMiddleware, type AuthEnv } from "../middleware/auth.js";
import {
  requireAgentAccess,
  handleAgentAccessError,
  AgentAccessError,
} from "../lib/agent-access.js";
import {
  newAgentToken,
  workspaceVolumeName,
  stateVolumeName,
  startAgent,
  stopAgent,
  destroyAgent,
} from "../agents/lifecycle.js";
import { getPtyHub } from "../agents/pty-hub.js";
import { planInjection } from "../agents/injector.js";
import { getProfile } from "../agents/adapters/profiles.js";
import { detectRuntimes } from "../sandbox/registry.js";
import { artifactBodyHeaders } from "../lib/artifact-csp.js";
import { channelAccess } from "./channels.js";

/**
 * Agent handles are the `@name` in a channel. Lowercase-only so that mention
 * parsing, the unique index, and the UI all agree on identity without needing
 * case folding at three different layers.
 */
const handleSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Handle must be lowercase letters, digits, - or _");

const createSchema = z.object({
  handle: handleSchema,
  displayName: z.string().min(1).max(120),
  blueprintId: z.string().uuid(),
  gitRepoUrl: z.string().url().optional().nullable(),
  gitBranch: z.string().max(200).optional().nullable(),
  systemPromptOverride: z.string().optional().nullable(),
  sandboxRuntime: z.enum(["auto", "runc", "runsc", "kata"]).optional(),
  egressPolicy: z.enum(["none", "allowlist", "open"]).optional(),
  dailyBudgetCents: z.number().int().positive().optional().nullable(),
});

const injectSchema = z.object({
  text: z.string().min(1),
  mode: z.enum(["queue", "interrupt"]).default("queue"),
});

/**
 * Tell the workspace an agent's container state changed.
 *
 * Start and stop are the two writes a human makes to a container, and neither
 * used to be broadcast — the sidecar's heartbeat was the only source of
 * `agent.status`, so a stopped agent kept its green dot until something else
 * happened to it.
 */
function announce(row: typeof schema.agents.$inferSelect) {
  streamBus.emit("workspace", {
    type: "agent.status",
    agentId: row.id,
    status: row.status,
    activity: row.activity ?? "unknown",
  });
}

/** Never leak `agentToken` — it authenticates the container to the server. */
function toAgentSummary(row: typeof schema.agents.$inferSelect) {
  const { agentToken: _agentToken, ...rest } = row;
  return rest;
}

const app = new Hono<AuthEnv>()
  .onError(handleAgentAccessError)

  .get("/", authMiddleware, async (c) => {
    const rows = await db
      .select()
      .from(schema.agents)
      .where(ne(schema.agents.status, "destroyed"))
      .orderBy(desc(schema.agents.createdAt));
    return c.json(rows.map(toAgentSummary));
  })

  .get("/runtimes", authMiddleware, async (c) => {
    return c.json(await detectRuntimes());
  })

  .post("/", authMiddleware, async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    }
    const input = parsed.data;

    const [blueprint] = await db
      .select()
      .from(schema.agentBlueprints)
      .where(eq(schema.agentBlueprints.id, input.blueprintId))
      .limit(1);
    if (!blueprint) return c.json({ error: "Blueprint not found" }, 404);

    const [existing] = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.handle, input.handle), ne(schema.agents.status, "destroyed")))
      .limit(1);
    if (existing) return c.json({ error: `@${input.handle} is already taken` }, 409);

    const id = crypto.randomUUID();
    const [created] = await db
      .insert(schema.agents)
      .values({
        id,
        handle: input.handle,
        displayName: input.displayName,
        blueprintId: blueprint.id,
        ownerId: c.get("session").user.id,
        status: "creating",
        containerImage: blueprint.image,
        agentToken: newAgentToken(),
        workspaceVolume: workspaceVolumeName(id),
        stateVolume: stateVolumeName(id),
        gitRepoUrl: input.gitRepoUrl ?? null,
        gitBranch: input.gitBranch ?? "main",
        systemPromptOverride: input.systemPromptOverride ?? null,
        sandboxRuntime: input.sandboxRuntime ?? blueprint.sandboxRuntime,
        egressPolicy: input.egressPolicy ?? blueprint.egressPolicy,
        dailyBudgetCents: input.dailyBudgetCents ?? null,
      })
      .returning();

    streamBus.emit("workspace", { type: "agent.created", agentId: created.id });
    return c.json(toAgentSummary(created), 201);
  })

  .get("/:id", authMiddleware, async (c) => {
    const agent = await requireAgentAccess(c.req.param("id")!, c.get("session").user);
    return c.json(toAgentSummary(agent));
  })

  /**
   * The blueprint behind one agent, for the Agent Detail header.
   *
   * `GET /api/settings/blueprints` already returns this, but it is
   * `adminMiddleware`-gated and hands back the whole row — `dockerfileContent`,
   * `envVars`, the lot. The header needs a name, a CLI and the resource caps,
   * and every user who can open an agent needs to see them, so this is the
   * narrow, `requireAgentAccess`-gated projection rather than a loosening of
   * the admin route.
   *
   * Replaces the hardcoded `mockBlueprint()` the header used to render, which
   * hashed the blueprint id into one of three invented names and reported
   * `ui-explorer` for a Claude Code agent.
   */
  .get("/:id/blueprint", authMiddleware, async (c) => {
    const agent = await requireAgentAccess(c.req.param("id")!, c.get("session").user);

    const [blueprint] = await db
      .select({
        id: schema.agentBlueprints.id,
        name: schema.agentBlueprints.name,
        cli: schema.agentBlueprints.cli,
        image: schema.agentBlueprints.image,
        // Nullable columns, passed through as null rather than defaulted: the
        // caps are "whatever the daemon allows" when unset, and inventing a
        // number here would be the bug this endpoint exists to remove.
        memoryBytes: schema.agentBlueprints.memoryBytes,
        nanoCpus: schema.agentBlueprints.nanoCpus,
        enableIde: schema.agentBlueprints.enableIde,
        enableBrowser: schema.agentBlueprints.enableBrowser,
      })
      .from(schema.agentBlueprints)
      .where(eq(schema.agentBlueprints.id, agent.blueprintId))
      .limit(1);

    if (!blueprint) return c.json({ error: "Blueprint not found" }, 404);
    return c.json(blueprint);
  })

  /**
   * What this agent has produced.
   *
   * Filtered by channel, for the same reason `/:id/results/latest` below is:
   * the agent gate is workspace-wide by design, artifacts are not, and a title
   * is enough to leak what is happening in a private room. One `channelAccess`
   * call per distinct channel, not per row.
   */
  .get("/:id/artifacts", authMiddleware, async (c) => {
    const agent = await requireAgentAccess(c.req.param("id")!, c.get("session").user);
    const user = c.get("session").user;
    const rows = await db
      .select({
        id: schema.artifacts.id,
        channelId: schema.artifacts.channelId,
        kind: schema.artifacts.kind,
        title: schema.artifacts.title,
        contentType: schema.artifacts.contentType,
        url: schema.artifacts.url,
        sizeBytes: schema.artifacts.sizeBytes,
        createdAt: schema.artifacts.createdAt,
      })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.agentId, agent.id))
      .orderBy(desc(schema.artifacts.createdAt))
      .limit(50);

    const channelIds = [...new Set(rows.map((row) => row.channelId))];
    const readable = new Set<string>();
    for (const channelId of channelIds) {
      const [channel] = await db
        .select()
        .from(schema.channels)
        .where(eq(schema.channels.id, channelId))
        .limit(1);
      if (channel && (await channelAccess(channel, user)).canRead) readable.add(channelId);
    }

    return c.json(rows.filter((row) => readable.has(row.channelId)));
  })

  /**
   * The agent's most recent rendered artifact, served as a document.
   *
   * Returned as raw HTML rather than JSON because the result viewer renders it
   * in a sandboxed iframe — the body is agent-authored and therefore untrusted,
   * so it is served with a restrictive CSP and never interpolated into the SPA.
   *
   * Two things were wrong here and both are fixed above.
   *
   * `requireAgentAccess` alone was the whole gate, and it takes the user only
   * to ignore it (`server/lib/agent-access.ts`, note the `_user` parameter) —
   * agents are workspace-shared on purpose. Artifacts are not: this route
   * served an agent's newest HTML, including one submitted into a **private
   * channel**, to any signed-in account. So the newest readable artifact is now
   * chosen by walking recent candidates and asking `channelAccess` about each,
   * rather than taking row one and trusting the agent gate.
   *
   * The CSP was also its own, looser copy — `script-src 'unsafe-inline' https:`
   * and `img-src https:` let the document reach any host on the internet. It
   * now shares the single constant with the artifact routes; see
   * `server/lib/artifact-csp.ts` for why there is no `https:` in it.
   */
  .get("/:id/results/latest", authMiddleware, async (c) => {
    const agent = await requireAgentAccess(c.req.param("id")!, c.get("session").user);
    const user = c.get("session").user;

    // A small window rather than one row: the newest artifact may be in a room
    // this user cannot see, and "the newest one you are allowed to read" is the
    // honest answer. Bounded so an agent with thousands of artifacts cannot
    // turn this into a scan.
    const candidates = await db
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.agentId, agent.id), eq(schema.artifacts.kind, "html")))
      .orderBy(desc(schema.artifacts.createdAt))
      .limit(20);

    let artifact: (typeof candidates)[number] | undefined;
    for (const row of candidates) {
      if (!row.body) continue;
      const [channel] = await db
        .select()
        .from(schema.channels)
        .where(eq(schema.channels.id, row.channelId))
        .limit(1);
      if (!channel) continue;
      const access = await channelAccess(channel, user);
      if (access.canRead) {
        artifact = row;
        break;
      }
    }

    if (!artifact?.body) return c.json({ error: "No result yet" }, 404);

    return c.body(artifact.body, 200, artifactBodyHeaders("text/html; charset=utf-8"));
  })

  .post("/:id/start", authMiddleware, async (c) => {
    const agent = await requireAgentAccess(c.req.param("id")!, c.get("session").user);
    try {
      // No `status === "running"` short-circuit here: the row can outlive the
      // container it describes. `startAgent` asks the runtime and returns early
      // itself when there is genuinely something alive to return to.
      const started = await startAgent(agent.id);
      // Lifecycle writes were invisible to the rail: only the sidecar's own
      // `/state` heartbeat used to broadcast, so a container coming up or going
      // down never reached a roster that no longer remounts.
      announce(started);
      return c.json(toAgentSummary(started));
    } catch (err) {
      await db
        .update(schema.agents)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(schema.agents.id, agent.id));
      streamBus.emit("workspace", {
        type: "agent.status",
        agentId: agent.id,
        status: "error",
        activity: agent.activity ?? "unknown",
      });
      return c.json(
        { error: `Failed to start agent: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  })

  .post("/:id/stop", authMiddleware, async (c) => {
    const agent = await requireAgentAccess(c.req.param("id")!, c.get("session").user);
    const stopped = await stopAgent(agent.id);
    announce(stopped);
    return c.json(toAgentSummary(stopped));
  })

  .delete("/:id", authMiddleware, adminMiddleware, async (c) => {
    const agent = await requireAgentAccess(c.req.param("id")!, c.get("session").user);
    await destroyAgent(agent.id);
    streamBus.emit("workspace", { type: "agent.removed", agentId: agent.id });
    return c.json({ ok: true });
  })

  /**
   * Write a prompt onto the agent's live PTY.
   *
   * This is the mechanism the whole product rests on, exposed directly so it
   * is demoable before channels exist. `queue` refuses when the agent is busy
   * rather than interleaving with a running turn; `interrupt` sends the
   * adapter's interrupt key first and accepts that in-flight work is lost.
   */
  .post("/:id/inject", authMiddleware, async (c) => {
    const agent = await requireAgentAccess(c.req.param("id")!, c.get("session").user);
    const parsed = injectSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    }
    if (agent.status !== "running" || !agent.containerId) {
      throw new AgentAccessError("Agent is not running", 409);
    }
    if (agent.pausedAt) {
      throw new AgentAccessError("Agent is paused (budget cap reached)", 409);
    }

    const { text, mode } = parsed.data;

    if (mode === "queue" && agent.activity === "busy") {
      return c.json({ queued: true, reason: "Agent is busy; delivers when idle" }, 202);
    }

    // Timing and key bindings are per-CLI: ESC-to-interrupt is Claude Code's
    // binding, and paste-coalescing windows differ between TUIs.
    const [blueprint] = await db
      .select({ cli: schema.agentBlueprints.cli })
      .from(schema.agentBlueprints)
      .where(eq(schema.agentBlueprints.id, agent.blueprintId))
      .limit(1);
    const profile = getProfile(blueprint?.cli);
    const steps = planInjection(text, profile, { mode });

    const hub = getPtyHub();
    await hub.ensureAttached(agent.id);
    // `inject` owns the inter-chunk gaps, and they are not cosmetic: a PTY line
    // discipline drops oversized single writes, and a `\r` racing the TUI's
    // paste-coalescing window submits a half-received prompt. Looping `write`
    // here re-acquired the mutex per chunk and let peer keystrokes interleave —
    // see the note in `agents/queue.ts`.
    await hub.inject(agent.id, steps);

    return c.json({ queued: false, steps: steps.length });
  });

export default app;
