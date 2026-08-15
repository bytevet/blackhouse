/**
 * Resolving an agent's effective egress allowlist.
 *
 * `egress_rules` is authoritative at connect time. A rule reaches an agent when
 * it is scoped to the whole `workspace`, to that agent's `blueprint`, or to the
 * `agent` itself — the effective list is the union of those three.
 *
 * The blueprint's `egressAllowlist` jsonb is a *creation-time default*, not a
 * fourth source. Unioning it at connect time would make the Settings table a
 * lie: an operator who deletes a host there would still see it granted, because
 * the jsonb copy kept working. Instead {@link materializeBlueprintDefaults}
 * copies the jsonb into blueprint-scoped rows once, after which the table is
 * the only thing anyone has to read to know what an agent can reach.
 *
 * "Once" is enforced by "this blueprint has no blueprint-scoped rules yet",
 * which has one documented edge: deleting *every* rule for a blueprint restores
 * the jsonb defaults on the next agent start. Deleting some of them does not.
 * The alternative — a `defaults_materialized_at` column — needs a migration in
 * a file this phase does not own.
 */

import { createHash } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { canonicalizeRules, type EgressMode } from "./allowlist.js";

type AgentRow = typeof schema.agents.$inferSelect;
type BlueprintRow = typeof schema.agentBlueprints.$inferSelect;

export interface AgentEgressPolicy {
  mode: EgressMode;
  /** Canonical (normalized, deduped, sorted) allowlist. Empty for `none`. */
  rules: string[];
  /**
   * Identity of this policy. Agents that hash to the same key share one proxy
   * container and one internal network instead of getting one each.
   */
  policyKey: string;
}

/**
 * `sha1(canonical allowlist)`.
 *
 * Canonicalization before hashing is the whole point: two allowlists differing
 * only in order, case, punycode spelling, or duplicates describe the same
 * policy and must land on the same proxy. sha1 is used as a content
 * fingerprint, never as a security primitive — nothing is authenticated by it,
 * and a collision would merge two policies that an operator can see side by
 * side in the Settings table.
 */
export function policyKeyFor(rules: readonly string[]): string {
  const canonical = canonicalizeRules(rules);
  return createHash("sha1").update(canonical.join("\n"), "utf8").digest("hex");
}

/** The policy key for a mode that never consults the allowlist. */
export const POLICY_KEY_NONE = "none";
export const POLICY_KEY_OPEN = "open";

/** The mode actually in force for an agent: its own override, else the blueprint's. */
export function modeFor(
  agent: Pick<AgentRow, "egressPolicy">,
  blueprint: BlueprintRow,
): EgressMode {
  return (agent.egressPolicy ?? blueprint.egressPolicy) as EgressMode;
}

/**
 * Copy a blueprint's `egressAllowlist` jsonb into blueprint-scoped rules, once.
 * Returns how many rows were inserted. Safe to call on every agent start.
 */
export async function materializeBlueprintDefaults(
  blueprint: BlueprintRow,
  addedByUserId?: string | null,
): Promise<number> {
  const defaults = canonicalizeRules(blueprint.egressAllowlist ?? []);
  if (defaults.length === 0) return 0;

  const [existing] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.egressRules)
    .where(
      and(
        eq(schema.egressRules.scope, "blueprint"),
        eq(schema.egressRules.blueprintId, blueprint.id),
      ),
    );
  if ((existing?.n ?? 0) > 0) return 0;

  const inserted = await db
    .insert(schema.egressRules)
    .values(
      defaults.map((host) => ({
        host,
        scope: "blueprint" as const,
        blueprintId: blueprint.id,
        addedByUserId: addedByUserId ?? blueprint.createdBy ?? null,
        note: "Imported from blueprint default allowlist",
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.egressRules.id });

  return inserted.length;
}

/**
 * The union of workspace-, blueprint-, and agent-scoped rules, canonicalized.
 *
 * One query, not three: the scope column is indexed and the CHECK constraint
 * guarantees exactly one of `blueprint_id` / `agent_id` is set per row, so the
 * three-way `OR` cannot pick up a row from a scope it did not ask for.
 */
export async function resolveEffectiveAllowlist(opts: {
  agentId?: string | null;
  blueprintId?: string | null;
}): Promise<string[]> {
  const scopes = [eq(schema.egressRules.scope, "workspace")];
  if (opts.blueprintId) {
    scopes.push(
      and(
        eq(schema.egressRules.scope, "blueprint"),
        eq(schema.egressRules.blueprintId, opts.blueprintId),
      )!,
    );
  }
  if (opts.agentId) {
    scopes.push(
      and(eq(schema.egressRules.scope, "agent"), eq(schema.egressRules.agentId, opts.agentId))!,
    );
  }

  const rows = await db
    .select({ host: schema.egressRules.host })
    .from(schema.egressRules)
    .where(or(...scopes));

  return canonicalizeRules(rows.map((r) => r.host));
}

/**
 * The full policy for one agent: mode, effective rules, and the sharing key.
 *
 * `open` and `none` never consult the allowlist, so they get fixed keys rather
 * than a hash of a list nobody reads — which also means every `none` agent
 * shares one internal network with no proxy on it at all.
 */
export async function resolveAgentEgress(
  agent: AgentRow,
  blueprint: BlueprintRow,
): Promise<AgentEgressPolicy> {
  const mode = modeFor(agent, blueprint);
  if (mode === "open") return { mode, rules: ["*"], policyKey: POLICY_KEY_OPEN };
  if (mode === "none") return { mode, rules: [], policyKey: POLICY_KEY_NONE };

  await materializeBlueprintDefaults(blueprint);
  const rules = await resolveEffectiveAllowlist({
    agentId: agent.id,
    blueprintId: agent.blueprintId,
  });

  // An allowlist agent with zero rules is a legitimate, maximally restrictive
  // policy — deny everything outbound — and NOT an error. It still reaches the
  // harness, which is on the internal network and in NO_PROXY, so the sidecar
  // and skill scripts keep working.
  return { mode, rules, policyKey: policyKeyFor(rules) };
}

/**
 * Every distinct policy currently in force, as the proxy-facing bundle. Used by
 * `GET /api/egress/policy` to answer "which agents may use the proxy for key K,
 * and what may they reach".
 *
 * Token *hashes*, never tokens: a compromised proxy must not be able to
 * impersonate an agent against the Blackhouse API.
 */
export async function policyBundle(policyKey: string): Promise<{
  policyKey: string;
  rules: string[];
  agents: Array<{ id: string; handle: string; mode: EgressMode; tokenHash: string }>;
} | null> {
  const rows = await db
    .select({ agent: schema.agents, blueprint: schema.agentBlueprints })
    .from(schema.agents)
    .innerJoin(schema.agentBlueprints, eq(schema.agents.blueprintId, schema.agentBlueprints.id))
    .where(sql`${schema.agents.status} <> 'destroyed'`);

  let rules: string[] | null = null;
  const agents: Array<{ id: string; handle: string; mode: EgressMode; tokenHash: string }> = [];

  for (const row of rows) {
    const policy = await resolveAgentEgress(row.agent, row.blueprint);
    if (policy.policyKey !== policyKey) continue;
    rules = policy.rules;
    if (!row.agent.agentToken) continue;
    agents.push({
      id: row.agent.id,
      handle: row.agent.handle,
      mode: policy.mode,
      tokenHash: createHash("sha256").update(row.agent.agentToken, "utf8").digest("hex"),
    });
  }

  if (rules === null) return null;
  return { policyKey, rules, agents };
}
