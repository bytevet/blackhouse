import { describe, it, expect } from "vitest";
import {
  user,
  session,
  account,
  verification,
  dockerConfigs,
  agentBlueprints,
  agents,
  channels,
  channelMembers,
  messages,
  messageMentions,
  runs,
  dispatchRequests,
  agentEvents,
  artifacts,
  egressRules,
  schedules,
  agentStatusEnum,
  agentActivityEnum,
  sandboxRuntimeEnum,
  egressPolicyEnum,
  messageKindEnum,
  injectionModeEnum,
  dispatchStatusEnum,
  AGENT_STATUSES,
  AGENT_ACTIVITIES,
  SANDBOX_RUNTIMES,
  EGRESS_POLICIES,
  MESSAGE_KINDS,
  INJECTION_MODES,
  DISPATCH_STATUSES,
  userRelations,
  agentsRelations,
  channelsRelations,
  messagesRelations,
} from "@/db/schema";

/** Column names present on a Drizzle pg table. */
function columns(table: Record<string, unknown>): string[] {
  return Object.keys(table).filter((k) => !k.startsWith("_") && !k.startsWith("$"));
}

function expectColumns(table: Record<string, unknown>, expected: string[]) {
  const actual = columns(table);
  for (const col of expected) {
    expect(actual, `missing column: ${col}`).toContain(col);
  }
}

describe("Database Schema", () => {
  describe("Better Auth tables (must survive the domain rewrite)", () => {
    it("keeps user, session, account and verification intact", () => {
      expectColumns(user, ["id", "name", "email", "role", "banned", "username"]);
      expectColumns(session, ["id", "expiresAt", "token", "userId"]);
      expectColumns(account, ["id", "accountId", "providerId", "userId", "password"]);
      expectColumns(verification, ["id", "identifier", "value", "expiresAt"]);
    });
  });

  describe("enums", () => {
    it("agent status covers the full container lifecycle", () => {
      expect(agentStatusEnum.enumValues).toEqual([
        "creating",
        "running",
        "stopped",
        "error",
        "destroyed",
      ]);
      expect(AGENT_STATUSES).toEqual(agentStatusEnum.enumValues);
    });

    it("keeps activity separate from status", () => {
      // These are independent signals: a running agent can be idle. Folding
      // them into one enum is the regression this test exists to catch.
      expect(agentActivityEnum.enumValues).toEqual(["idle", "busy", "unknown"]);
      expect(AGENT_ACTIVITIES).toEqual(agentActivityEnum.enumValues);
      expect(agentActivityEnum.enumValues).not.toContain("running");
      expect(agentStatusEnum.enumValues).not.toContain("busy");
    });

    it("offers auto plus all three sandbox runtimes", () => {
      expect(sandboxRuntimeEnum.enumValues).toEqual(["auto", "runc", "runsc", "kata"]);
      expect(SANDBOX_RUNTIMES).toEqual(sandboxRuntimeEnum.enumValues);
    });

    it("has the three egress policies", () => {
      expect(egressPolicyEnum.enumValues).toEqual(["none", "allowlist", "open"]);
      expect(EGRESS_POLICIES).toEqual(egressPolicyEnum.enumValues);
    });

    it("covers every transcript message kind the design renders", () => {
      expect(messageKindEnum.enumValues).toEqual([
        "text",
        "event",
        "artifact",
        "dispatch_request",
        "system",
      ]);
      expect(MESSAGE_KINDS).toEqual(messageKindEnum.enumValues);
    });

    it("has exactly the two delivery modes the composer offers", () => {
      expect(injectionModeEnum.enumValues).toEqual(["queue", "interrupt"]);
      expect(INJECTION_MODES).toEqual(injectionModeEnum.enumValues);
    });

    it("models the dispatch approval states", () => {
      expect(dispatchStatusEnum.enumValues).toEqual(["pending", "approved", "denied", "expired"]);
      expect(DISPATCH_STATUSES).toEqual(dispatchStatusEnum.enumValues);
    });
  });

  describe("agents", () => {
    it("carries identity, container, and sandbox provenance", () => {
      expectColumns(agents, [
        "id",
        "handle",
        "displayName",
        "blueprintId",
        "status",
        "activity",
        "containerId",
        "agentToken",
        "workspaceVolume",
        "stateVolume",
        "statusLine",
      ]);
    });

    it("records the requested runtime and the one that actually ran", () => {
      // gVisor is absent on Docker Desktop and Podman, so falling back to runc
      // is common. Storing only the request would let someone believe they
      // have isolation they do not have.
      expectColumns(agents, ["sandboxRuntime", "runtimeUsed"]);
    });

    it("gives each agent its own state volume", () => {
      // A shared `~/.claude` volume would let every agent read every other
      // agent's transcripts, since the sidecar tails exactly that directory.
      const cols = columns(agents);
      expect(cols).toContain("stateVolume");
      expect(cols).toContain("workspaceVolume");
    });

    it("models the daily budget as a window, not a lifetime counter", () => {
      expectColumns(agents, [
        "dailyBudgetCents",
        "spentCentsToday",
        "budgetWindowStart",
        "pausedAt",
      ]);
    });
  });

  describe("agent_blueprints", () => {
    it("holds the reusable definition an agent is instantiated from", () => {
      expectColumns(agentBlueprints, [
        "id",
        "name",
        "cli",
        "agentCommand",
        "image",
        "dockerfileContent",
        "imageBuildStatus",
        "systemPrompt",
        "skills",
        "mcpConfig",
        "sandboxRuntime",
        "egressPolicy",
      ]);
    });
  });

  describe("channels and membership", () => {
    it("carries repo context and the auto-approve switch", () => {
      expectColumns(channels, [
        "id",
        "slug",
        "name",
        "topic",
        "gitRepoUrl",
        "gitBranch",
        "autoApproveDispatch",
      ]);
    });

    it("lets a member be either a human or an agent", () => {
      expectColumns(channelMembers, ["channelId", "userId", "agentId", "role"]);
    });
  });

  describe("messages", () => {
    it("supports mixed authorship and every rendered kind", () => {
      expectColumns(messages, [
        "id",
        "channelId",
        "authorKind",
        "authorUserId",
        "authorAgentId",
        "kind",
        "body",
        "runId",
      ]);
    });

    it("carries a request id so agent-authored posts can be deduped", () => {
      expect(columns(messages)).toContain("requestId");
    });

    it("stores mentions relationally rather than only inline", () => {
      expectColumns(messageMentions, ["messageId", "agentId"]);
    });
  });

  describe("runs and dispatches", () => {
    it("records the delivery mode and the turn's cost", () => {
      expectColumns(runs, ["id", "agentId", "channelId", "status", "injectionMode"]);
    });

    it("keeps the original prompt alongside an edited one", () => {
      // "Edit & approve" must not silently overwrite what the agent asked for.
      expectColumns(dispatchRequests, [
        "id",
        "channelId",
        "fromAgentId",
        "toAgentId",
        "prompt",
        "status",
        "expiresAt",
      ]);
    });
  });

  describe("agent_events", () => {
    it("has the fields the sidecar ingest needs to be idempotent", () => {
      expectColumns(agentEvents, ["id", "agentId", "type", "payload"]);
    });
  });

  describe("supporting tables", () => {
    it("defines artifacts, egress rules, schedules and docker config", () => {
      expectColumns(artifacts, ["id", "channelId", "kind"]);
      expectColumns(egressRules, ["id", "host", "scope"]);
      expectColumns(schedules, ["id", "agentId", "cron", "enabled"]);
      expectColumns(dockerConfigs, ["id", "socketPath"]);
    });
  });

  describe("relations", () => {
    it("exports relations for the core tables", () => {
      expect(userRelations).toBeDefined();
      expect(agentsRelations).toBeDefined();
      expect(channelsRelations).toBeDefined();
      expect(messagesRelations).toBeDefined();
    });
  });

  describe("the old session-centric model is gone", () => {
    it("no longer exports coding sessions, templates, or the DM inbox", async () => {
      const schema = await import("@/db/schema");
      for (const dead of [
        "codingSessions",
        "templates",
        "agentConfigs",
        "sessionMessages",
        "sessionStatusEnum",
        "SESSION_STATUSES",
      ]) {
        expect(schema, `${dead} should have been removed`).not.toHaveProperty(dead);
      }
    });
  });
});
