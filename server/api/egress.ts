/**
 * Egress rules API — the Settings → Egress allowlist screen, plus the endpoint
 * the proxies themselves poll.
 *
 * Reads are available to any signed-in user (knowing what an agent may reach is
 * not privileged; it is the thing everyone needs to reason about a transcript).
 * Every mutation is admin-only: adding a host here widens what untrusted,
 * model-authored code can talk to, which is the most consequential edit in the
 * product.
 *
 * `GET /policy` is the exception to both — it is called by the proxy containers,
 * which have no Better Auth session, and is authenticated with a bearer token
 * derived from `BETTER_AUTH_SECRET`.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";
import { bearerToken } from "../lib/agent-token-auth.js";
import { canonicalizeRules, matchHost } from "../egress/allowlist.js";
import {
  materializeBlueprintDefaults,
  policyBundle,
  policyKeyFor,
  resolveAgentEgress,
  resolveEffectiveAllowlist,
} from "../egress/rules.js";
import { proxyToken } from "../egress/proxy-manager.js";
import { egressEnforceEnabled, evaluateEnforcement, harnessHostname } from "../egress/attach.js";

const app = new Hono();

/**
 * Normalize a host the operator typed into the canonical form the matcher
 * compares against, or reject it.
 *
 * Storing the raw string and normalizing at connect time would mean the table
 * shows one thing and the proxy enforces another. `canonicalizeRules` drops
 * anything malformed, so an empty result is a rejection — which is also what
 * keeps a typo from being stored as a rule that silently never matches.
 */
function normalizeRuleHost(input: string): string | null {
  const [canonical] = canonicalizeRules([input]);
  if (!canonical) return null;
  if (canonical === "*") return canonical;

  // Second gate, and this one is a UX decision rather than a security one.
  // The matcher is a pure comparator: it will happily store `!!!`, which
  // WHATWG parses as a legal host, and then never match it because no such
  // name resolves. A rule that can never fire is worse than a rejected one —
  // the operator believes they granted something. So the API insists a rule
  // look like a host a resolver could plausibly answer for.
  const body = canonical.replace(/^\./, "").replace(/:(\d+|\*)$/, "");
  const plausible = /^\[[0-9a-f:]+\]$/.test(body) || /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(body);
  return plausible ? canonical : null;
}

const ruleBody = z.object({
  host: z.string().min(1).max(255),
  scope: z.enum(["workspace", "blueprint", "agent"]).default("workspace"),
  blueprintId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

const routes = app
  // -------------------------------------------------------------------------
  // Rules — the `host · scope · added by` table
  // -------------------------------------------------------------------------
  .get("/rules", authMiddleware, async (c) => {
    const rows = await db
      .select({
        id: schema.egressRules.id,
        host: schema.egressRules.host,
        scope: schema.egressRules.scope,
        blueprintId: schema.egressRules.blueprintId,
        agentId: schema.egressRules.agentId,
        note: schema.egressRules.note,
        createdAt: schema.egressRules.createdAt,
        addedByUserId: schema.egressRules.addedByUserId,
        addedByName: schema.user.name,
        blueprintName: schema.agentBlueprints.name,
        agentHandle: schema.agents.handle,
      })
      .from(schema.egressRules)
      .leftJoin(schema.user, eq(schema.egressRules.addedByUserId, schema.user.id))
      .leftJoin(
        schema.agentBlueprints,
        eq(schema.egressRules.blueprintId, schema.agentBlueprints.id),
      )
      .leftJoin(schema.agents, eq(schema.egressRules.agentId, schema.agents.id))
      .orderBy(desc(schema.egressRules.createdAt));

    return c.json(
      rows.map((r) => ({
        ...r,
        // One display string per row, resolved server-side so the table does
        // not have to join three lists client-side to render one column.
        scopeLabel:
          r.scope === "workspace"
            ? "workspace"
            : r.scope === "blueprint"
              ? (r.blueprintName ?? "blueprint")
              : `@${r.agentHandle ?? "agent"}`,
      })),
    );
  })

  .post("/rules", adminMiddleware, zValidator("json", ruleBody), async (c) => {
    const data = c.req.valid("json");
    const session = c.get("session");

    const host = normalizeRuleHost(data.host);
    if (!host) {
      return c.json(
        {
          error:
            "Not a usable rule. Expected a host (example.com), a subdomain " +
            "wildcard (.example.com), an explicit port (example.com:8443), or an IP literal.",
        },
        400,
      );
    }

    if (data.scope === "blueprint" && !data.blueprintId) {
      return c.json({ error: "blueprintId is required for a blueprint-scoped rule" }, 400);
    }
    if (data.scope === "agent" && !data.agentId) {
      return c.json({ error: "agentId is required for an agent-scoped rule" }, 400);
    }

    const inserted = await db
      .insert(schema.egressRules)
      .values({
        host,
        scope: data.scope,
        // The CHECK constraint requires the other target to be null, so these
        // are cleared rather than passed through.
        blueprintId: data.scope === "blueprint" ? (data.blueprintId ?? null) : null,
        agentId: data.scope === "agent" ? (data.agentId ?? null) : null,
        addedByUserId: session.user.id,
        note: data.note ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) {
      return c.json({ error: "That host is already allowed at this scope" }, 409);
    }
    return c.json(inserted[0], 201);
  })

  .delete("/rules/:id", adminMiddleware, async (c) => {
    const deleted = await db
      .delete(schema.egressRules)
      .where(eq(schema.egressRules.id, c.req.param("id")))
      .returning({ id: schema.egressRules.id });

    if (deleted.length === 0) return c.json({ error: "Rule not found" }, 404);
    // Proxies refetch on a 30s cycle, so a removal is live within one refresh
    // for every already-running agent. No restart, no recreate.
    return c.json({ success: true, appliesWithinSeconds: 30 });
  })

  // -------------------------------------------------------------------------
  // Status — is any of this actually binding?
  // -------------------------------------------------------------------------
  .get("/status", authMiddleware, async (c) => {
    const enforceFlag = await egressEnforceEnabled();
    const networkName = process.env.BLACKHOUSE_NETWORK;
    const blackhouseUrl =
      process.env.BLACKHOUSE_CONTAINER_URL || "http://host.docker.internal:3000";

    // Evaluated against `allowlist`, the default policy — `open` would always
    // report "not enforced" and say nothing about the instance.
    const { enforce, reason } = evaluateEnforcement({
      mode: "allowlist",
      egressEnforce: enforceFlag,
      networkName,
      blackhouseUrl,
    });

    return c.json({
      enforced: enforce,
      reason,
      egressEnforceFlag: enforceFlag,
      containerNetwork: networkName ?? null,
      harnessHost: harnessHostname(blackhouseUrl),
    });
  })

  /** The effective allowlist for one agent, with its policy key. */
  .get("/agents/:id/effective", authMiddleware, async (c) => {
    const id = c.req.param("id");
    const [row] = await db
      .select({ agent: schema.agents, blueprint: schema.agentBlueprints })
      .from(schema.agents)
      .innerJoin(schema.agentBlueprints, eq(schema.agents.blueprintId, schema.agentBlueprints.id))
      .where(eq(schema.agents.id, id))
      .limit(1);

    if (!row) return c.json({ error: "Agent not found" }, 404);

    const policy = await resolveAgentEgress(row.agent, row.blueprint);
    return c.json({ agentId: id, ...policy, enforced: await egressEnforceEnabled() });
  })

  /**
   * Dry-run a host against an agent's effective policy. The same matcher the
   * proxy runs, so "why was this blocked" is answerable without reading
   * container logs.
   */
  .get("/agents/:id/test", authMiddleware, async (c) => {
    const host = c.req.query("host");
    if (!host) return c.json({ error: "host query parameter is required" }, 400);

    const [row] = await db
      .select({ agent: schema.agents, blueprint: schema.agentBlueprints })
      .from(schema.agents)
      .innerJoin(schema.agentBlueprints, eq(schema.agents.blueprintId, schema.agentBlueprints.id))
      .where(eq(schema.agents.id, c.req.param("id")))
      .limit(1);

    if (!row) return c.json({ error: "Agent not found" }, 404);

    const policy = await resolveAgentEgress(row.agent, row.blueprint);
    if (policy.mode === "open") return c.json({ host, allowed: true, rule: "*", reason: null });
    if (policy.mode === "none") {
      return c.json({ host, allowed: false, rule: null, reason: "mode-none" });
    }
    return c.json({ host, ...matchHost(host, policy.rules) });
  })

  /** Preview the union for a blueprint without needing an agent to exist. */
  .get("/blueprints/:id/effective", authMiddleware, async (c) => {
    const blueprintId = c.req.param("id");
    const rules = await resolveEffectiveAllowlist({ blueprintId });
    return c.json({ blueprintId, rules, policyKey: policyKeyFor(rules) });
  })

  // -------------------------------------------------------------------------
  // Proxy-facing: policy bundle
  // -------------------------------------------------------------------------
  /**
   * Called by the egress proxies every 30s. Not session-authenticated — the
   * proxy has no cookie — but the token is derived from `BETTER_AUTH_SECRET`,
   * so possessing it is equivalent to possessing the instance secret.
   *
   * Returns token *hashes*. A proxy that is compromised must not come away with
   * credentials it can replay against the rest of the API.
   */
  .get("/policy", async (c) => {
    const presented = bearerToken(c.req.header("Authorization"));
    if (!presented) return c.json({ error: "Unauthorized" }, 401);

    let expected: string;
    try {
      expected = proxyToken();
    } catch {
      return c.json({ error: "Egress proxy token is not configured" }, 503);
    }

    const a = Buffer.from(presented, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const key = c.req.query("key");
    if (!key) return c.json({ error: "key query parameter is required" }, 400);

    const bundle = await policyBundle(key);
    // No agent currently maps to this key — the proxy is orphaned. An empty
    // bundle (rather than a 404) tells it to deny everything, which is the
    // correct behaviour for a proxy nothing is supposed to be using.
    if (!bundle) return c.json({ policyKey: key, rules: [], agents: [] });
    return c.json(bundle);
  })

  // -------------------------------------------------------------------------
  // Blueprint defaults
  // -------------------------------------------------------------------------
  /**
   * Copy a blueprint's `egressAllowlist` jsonb into blueprint-scoped rules.
   * Normally this happens on the first agent start; this makes it explicit for
   * an operator who wants to edit the defaults before ever launching an agent.
   */
  .post("/blueprints/:id/materialize", adminMiddleware, async (c) => {
    const blueprintId = c.req.param("id");
    const session = c.get("session");

    const [blueprint] = await db
      .select()
      .from(schema.agentBlueprints)
      .where(eq(schema.agentBlueprints.id, blueprintId))
      .limit(1);
    if (!blueprint) return c.json({ error: "Blueprint not found" }, 404);

    const inserted = await materializeBlueprintDefaults(blueprint, session.user.id);

    const existing = await db
      .select({ id: schema.egressRules.id })
      .from(schema.egressRules)
      .where(
        and(
          eq(schema.egressRules.scope, "blueprint"),
          eq(schema.egressRules.blueprintId, blueprintId),
        ),
      );

    return c.json({ inserted, total: existing.length });
  });

export default routes;
