import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  bigserial,
  jsonb,
  uuid,
  pgEnum,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// --- Better Auth managed tables ---
//
// Kept verbatim across the multi-agent-harness cutover. Better Auth owns
// these shapes; changing a column here means changing a Better Auth plugin
// contract, not a Blackhouse one.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  role: text("role").default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  username: text("username").unique(),
  displayUsername: text("display_username"),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// --- Enums ---

/** Sidecar adapter key. Also selects the injection timing profile — the
 *  `custom` bucket inherits server-side PTY-scrape and the conservative
 *  timings, which is the documented degradation for BYO CLIs. */
export const agentCliEnum = pgEnum("agent_cli", ["claude-code", "codex", "antigravity", "custom"]);

/** Process state of the agent's container. Deliberately NOT activity —
 *  see `agentActivityEnum`; the two fail independently. */
export const agentStatusEnum = pgEnum("agent_status", [
  "creating",
  "running",
  "stopped",
  "error",
  "destroyed",
]);

/** What the agent is *doing*, maintained by the sidecar (and, for
 *  PTY-scrape adapters, by terminal quiescence alone). A `running`
 *  container can be `idle`; a `stopped` one is `unknown`, never `idle`.
 *  This is the signal that gates queue-until-idle injection, so
 *  `unknown` must be treated as "do not inject blind" by the dispatcher.
 *  Set to `unknown` after ~30s without a sidecar heartbeat. */
export const agentActivityEnum = pgEnum("agent_activity", ["idle", "busy", "unknown"]);

/** Requested sandbox driver. `auto` resolves at container-create time to
 *  `runsc` when the host advertises it, else `runc`. What actually ran is
 *  recorded separately in `agents.runtime_used` — an invisible fallback
 *  means believing you have isolation you don't. */
export const sandboxRuntimeEnum = pgEnum("sandbox_runtime", ["auto", "runc", "runsc", "kata"]);

/** `none` = no proxy credentials issued at all; `allowlist` = CONNECT
 *  proxy honouring the union of `egress_rules`; `open` = bridge network
 *  attached (and only then may `ExtraHosts: host-gateway` be set). */
export const egressPolicyEnum = pgEnum("egress_policy", ["none", "allowlist", "open"]);

/** Which of `egress_rules.blueprint_id` / `.agent_id` is populated —
 *  enforced by the `egress_rules_scope_target` CHECK below. */
export const egressScopeEnum = pgEnum("egress_scope", ["workspace", "blueprint", "agent"]);

export const channelMemberRoleEnum = pgEnum("channel_member_role", ["owner", "member"]);

export const messageAuthorKindEnum = pgEnum("message_author_kind", ["user", "agent", "system"]);

/** Transcript row type. `event` rows are the collapsed agent-turn
 *  summaries; the tool calls behind them live in `agent_events`. */
export const messageKindEnum = pgEnum("message_kind", [
  "text",
  "event",
  "artifact",
  "dispatch_request",
  "system",
]);

/** `queue` waits for `agents.activity = 'idle'`; `interrupt` writes ESC,
 *  waits out the TUI's redraw, then pastes. The UI treats interrupt as
 *  the heavier, danger-toned choice. */
export const injectionModeEnum = pgEnum("injection_mode", ["queue", "interrupt"]);

export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "injecting",
  "running",
  "done",
  "failed",
  "cancelled",
]);

export const dispatchStatusEnum = pgEnum("dispatch_status", [
  "pending",
  "approved",
  "denied",
  "expired",
]);

/** Sidecar event union. `status` carries the idle/busy heartbeat;
 *  `usage` carries the token counters that feed the budget. `raw` is the
 *  defensive catch-all: an adapter that meets an entry type it does not
 *  understand emits `raw` with the whole object rather than throwing —
 *  the upstream JSONL formats are undocumented and version-coupled, so
 *  the adapter has to degrade to "coarse but alive". */
export const agentEventTypeEnum = pgEnum("agent_event_type", [
  "turn_start",
  "assistant_text",
  "tool_use",
  "tool_result",
  "turn_end",
  "status",
  "usage",
  "raw",
]);

/** `html` is the old result-viewer payload, now posted as an artifact. */
export const artifactKindEnum = pgEnum("artifact_kind", ["html", "file", "link", "text"]);

// --- Infrastructure config ---

export const dockerConfigs = pgTable("docker_configs", {
  id: integer("id").primaryKey().default(1),
  socketPath: text("socket_path").default("/var/run/docker.sock"),
  host: text("host"),
  port: integer("port"),
  tlsCa: text("tls_ca"),
  tlsCert: text("tls_cert"),
  tlsKey: text("tls_key"),
  /** Instance-wide default for blueprints that ask for `auto`. Lets an
   *  operator on a gVisor host force `runsc` even for blueprints authored
   *  elsewhere. */
  defaultSandboxDriver: sandboxRuntimeEnum("default_sandbox_driver").notNull().default("auto"),
  /** Cached `docker info` → `{ runtimes: string[], defaultRuntime: string }`,
   *  probed at boot. Cached rather than probed per container-create: the
   *  daemon's runtime map only changes when the operator edits
   *  `daemon.json` and restarts Docker. */
  detectedRuntimes: jsonb("detected_runtimes").$type<{
    runtimes: string[];
    defaultRuntime: string | null;
  } | null>(),
  runtimeProbedAt: timestamp("runtime_probed_at"),
  /** Dev escape hatch (Phase 6). When false, agents keep the ordinary
   *  bridge network and the allowlist is advisory — because port
   *  publishing onto an `internal: true` network is not reliable in
   *  host-socket dev setups. Production Linux hosts flip this on. */
  egressEnforce: boolean("egress_enforce").notNull().default(false),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// --- Agents ---

/** Reusable agent definition: image + CLI + guardrails. `agents` are the
 *  named instances. Carries the image-build fields that used to live on
 *  `agent_configs`. */
export const agentBlueprints = pgTable(
  "agent_blueprints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Unique because the seed upserts by name and the create-agent
     *  wizard picks by name — two "Claude Code" rows would be a coin
     *  flip in both places. */
    name: text("name").notNull().unique(),
    description: text("description"),
    /** Sidecar adapter key — see `agentCliEnum`. */
    cli: agentCliEnum("cli").notNull().default("custom"),
    /** The process the entrypoint execs. Container-exit means agent-exit,
     *  so this must be the CLI itself, never a shell. */
    agentCommand: text("agent_command"),
    image: text("image"),
    dockerfileContent: text("dockerfile_content"),
    /** 'none' | 'building' | 'success' | 'error'. Kept as text (not an
     *  enum) exactly as it was on `agent_configs` — the build runner adds
     *  states faster than migrations are worth. */
    imageBuildStatus: text("image_build_status").notNull().default("none"),
    imageBuildLog: text("image_build_log"),
    lastBuiltAt: timestamp("last_built_at"),
    systemPrompt: text("system_prompt"),
    skills: jsonb("skills").$type<object[] | null>(),
    mcpConfig: jsonb("mcp_config").$type<object | null>(),
    envVars: jsonb("env_vars").$type<{ key: string; value: string }[] | null>(),
    /** Extra mounts beyond the per-agent workspace/state volumes, which
     *  are allocated per agent and never listed here — see `agents`.
     *  Shared volumes are legitimate here only for credentials
     *  (`claude-auth`), never for CLI state. */
    volumeMounts: jsonb("volume_mounts").$type<{ name: string; mountPath: string }[] | null>(),
    /** Where this CLI keeps its state, and therefore where the agent's
     *  OWN state volume gets mounted (`~/.claude`, `~/.gemini`,
     *  `~/.codex`). Per-blueprint because it is a property of the CLI,
     *  and load-bearing: point two agents at one volume here and the
     *  Claude Code sidecar, which tails `~/.claude/projects/**`, hands
     *  every agent every other agent's transcript. */
    stateMountPath: text("state_mount_path"),
    sandboxRuntime: sandboxRuntimeEnum("sandbox_runtime").notNull().default("auto"),
    egressPolicy: egressPolicyEnum("egress_policy").notNull().default("allowlist"),
    /** Convenience default copied into `egress_rules` at agent-create
     *  time. `egress_rules` is authoritative at connect time. */
    egressAllowlist: jsonb("egress_allowlist").$type<string[] | null>(),
    /** bigint, not integer: 2 GiB (2147483648) overflows int4 by one. */
    /**
     * Whether an agent from this blueprint runs code-server and the browser
     * service alongside its CLI.
     *
     * Both used to start unconditionally, and they are not small: a full VS Code
     * server, and node + Playwright + Chromium, inside a gVisor sandbox. One
     * such agent took a 2-CPU / 1.6GB host to load average 27 and stopped it
     * answering SSH. Most agents never open either tab.
     *
     * Default false, so an existing blueprint gets the lighter behaviour on
     * upgrade rather than keeping a cost nobody chose. Turning them on is one
     * switch in the blueprint form.
     */
    enableIde: boolean("enable_ide").notNull().default(false),
    enableBrowser: boolean("enable_browser").notNull().default(false),

    memoryBytes: bigint("memory_bytes", { mode: "number" }),
    nanoCpus: bigint("nano_cpus", { mode: "number" }),
    pidsLimit: integer("pids_limit"),
    isPublic: boolean("is_public").notNull().default(false),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_blueprints_created_by").on(table.createdBy),
    index("idx_blueprints_is_public").on(table.isPublic),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The `@name`. Unique case-insensitively — see the functional index
     *  below; `@Scout` and `@scout` must not be two agents, because
     *  mention parsing lowercases before resolving. */
    handle: text("handle").notNull(),
    displayName: text("display_name").notNull(),
    blueprintId: uuid("blueprint_id")
      .notNull()
      .references(() => agentBlueprints.id, { onDelete: "restrict" }),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),

    // --- Two independent signals, never collapse them ---
    /** Container lifecycle. */
    status: agentStatusEnum("status").notNull().default("creating"),
    /** What it is doing. A running agent can be idle; see the enums. */
    activity: agentActivityEnum("activity").notNull().default("unknown"),
    /** Freshness for `activity`. Older than the adapter's heartbeat
     *  window means the value is stale and must be read as `unknown`. */
    activityUpdatedAt: timestamp("activity_updated_at"),

    containerId: text("container_id"),
    containerImage: text("container_image"),
    /** Per-agent override of the blueprint's requested driver. NULL =
     *  inherit the blueprint. */
    sandboxRuntime: sandboxRuntimeEnum("sandbox_runtime"),
    /** What actually got selected after `auto` resolution and fallback.
     *  Badged in the UI whenever it differs from what was requested. */
    runtimeUsed: text("runtime_used"),
    /** NULL = inherit the blueprint's policy. */
    egressPolicy: egressPolicyEnum("egress_policy"),
    /** Bearer credential for the in-container sidecar and the skill
     *  scripts, and the proxy password in Phase 6. Per-agent, so a
     *  leaked token compromises one agent, not the instance. */
    agentToken: text("agent_token").unique(),

    /** Per-agent volumes. Two, not one, and never shared: the Claude Code
     *  adapter tails `~/.claude/projects/**`, so a state volume shared
     *  across agents would let every agent read every other agent's
     *  transcript. (`claude-auth`, which holds credentials only, may
     *  still be a shared mount via `blueprint.volumeMounts`.) */
    workspaceVolume: text("workspace_volume").notNull(),
    stateVolume: text("state_volume").notNull(),

    gitRepoUrl: text("git_repo_url"),
    gitBranch: text("git_branch").default("main"),
    /** One-line "what I'm up to", written by `update-title.sh`. Replaces
     *  the old `coding_sessions.agent_title`. */
    statusLine: text("status_line"),
    systemPromptOverride: text("system_prompt_override"),

    // --- Budget: a DAILY window, not a lifetime counter ---
    /** NULL = uncapped. */
    dailyBudgetCents: integer("daily_budget_cents"),
    spentCentsToday: integer("spent_cents_today").notNull().default(0),
    /** Start of the current window. Rolled forward lazily on read — no
     *  cron, so a paused-overnight instance still resets correctly on
     *  first touch the next day. */
    budgetWindowStart: timestamp("budget_window_start").notNull().defaultNow(),
    /** Paused ≠ stopped: the container and TUI stay up and attachable,
     *  but new runs are refused. Set when the daily cap is crossed. */
    pausedAt: timestamp("paused_at"),

    /** Lifetime, for reporting. Budget uses the daily counters above. */
    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // Case-insensitive handle uniqueness. Functional index rather than a
    // stored lowercase column so the display casing survives.
    uniqueIndex("uq_agents_handle_lower").on(sql`lower(${table.handle})`),
    index("idx_agents_status").on(table.status),
    index("idx_agents_owner_id").on(table.ownerId),
    index("idx_agents_blueprint_id").on(table.blueprintId),
    // Reconciler scan at boot: relink live containers, mark the vanished
    // ones stopped. Partial — destroyed agents are never reconciled.
    index("idx_agents_container_id")
      .on(table.containerId)
      .where(sql`container_id IS NOT NULL AND status <> 'destroyed'`),
  ],
);

// --- Channels ---

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    topic: text("topic"),
    isPrivate: boolean("is_private").notNull().default(false),
    isArchived: boolean("is_archived").notNull().default(false),
    /** Project context shown in the header (`acme/storefront @ main`) and
     *  pre-filled into agents created from this channel. The agent's own
     *  repo stays authoritative for its actual checkout. */
    gitRepoUrl: text("git_repo_url"),
    gitBranch: text("git_branch"),
    /** The "yolo" switch: agent→agent dispatch skips the human hold in
     *  this channel. Safety surface, not a convenience toggle — every
     *  flip must also write a `kind='system'` message into the channel,
     *  and dispatch cards are still recorded (auto-approve removes the
     *  *hold*, not the *record*). */
    autoApproveDispatch: boolean("auto_approve_dispatch").notNull().default(false),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // Sidebar list: active channels only, ordered by name.
    index("idx_channels_active")
      .on(table.name)
      .where(sql`is_archived = false`),
  ],
);

export const channelMembers = pgTable(
  "channel_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** Exactly one of agentId / userId is set — CHECK below. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    role: channelMemberRoleEnum("role").notNull().default("member"),
    /** Humans: drives the unread pill. */
    lastReadAt: timestamp("last_read_at"),
    /** Agents: the last `messages.seq` this agent has consumed via
     *  `read.sh`. Replaces the old per-message ack rows — one cursor per
     *  member instead of a row per delivery. */
    cursorSeq: bigint("cursor_seq", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // A membership is either a human's or an agent's, never both and
    // never neither. Without this, a NULL/NULL row is a ghost member
    // that shows in counts and matches no one.
    check(
      "channel_members_exactly_one_subject",
      sql`(${table.agentId} IS NOT NULL)::int + (${table.userId} IS NOT NULL)::int = 1`,
    ),
    // Partial uniques rather than one composite unique: a plain
    // UNIQUE(channel_id, agent_id, user_id) would not dedupe, because
    // NULLs are distinct in Postgres and every human row has a NULL
    // agent_id.
    uniqueIndex("uq_channel_members_user")
      .on(table.channelId, table.userId)
      .where(sql`user_id IS NOT NULL`),
    uniqueIndex("uq_channel_members_agent")
      .on(table.channelId, table.agentId)
      .where(sql`agent_id IS NOT NULL`),
    index("idx_channel_members_agent").on(table.agentId),
    index("idx_channel_members_user").on(table.userId),
  ],
);

// --- Transcript ---

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Monotonic ordering key. Global (one sequence) rather than
     *  per-channel: gapless-per-channel would need a serializable
     *  counter, and keyset pagination only needs monotonicity within a
     *  channel, which a global sequence already gives. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => messages.id, {
      onDelete: "cascade",
    }),
    authorKind: messageAuthorKindEnum("author_kind").notNull(),
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    kind: messageKindEnum("kind").notNull().default("text"),
    body: text("body"),
    /** Agent ids mentioned, denormalised so the transcript renders
     *  mention chips without a join. `message_mentions` is the
     *  relational form used for "mentions of me" queries. */
    mentions: jsonb("mentions")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Tool name for `event` rows, artifact ref for `artifact` rows,
     *  dispatch id for `dispatch_request` rows. */
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    /** Dedup key for agent-authored posts (`post.sh` retries). Matched
     *  within a 60s window in app code — see the index note below. */
    requestId: text("request_id"),
    runId: uuid("run_id").references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // Keyset pagination and the SSE tail both order by this. Unique
    // because `seq` comes from a sequence — free integrity check.
    uniqueIndex("idx_messages_channel_seq").on(table.channelId, table.seq),
    index("idx_messages_channel_created").on(table.channelId, table.createdAt),
    // Mention lookups (`WHERE mentions @> '["<agent-id>"]'`) — the
    // unread-mention dot in the sidebar.
    index("idx_messages_mentions").using("gin", table.mentions),
    // Dedup probe: (author_agent_id, request_id) inside a 60s window
    // returns the existing row instead of inserting. Deliberately NOT
    // unique — the window is enforced in app code, and the same
    // request_id reused a day later is a legitimate new message.
    index("idx_messages_dedup")
      .on(table.authorAgentId, table.requestId)
      .where(sql`request_id IS NOT NULL`),
    index("idx_messages_run_id").on(table.runId),
    index("idx_messages_parent_id").on(table.parentId),
  ],
);

/** Relational form of `messages.mentions`. The jsonb column renders the
 *  chips; this table answers "which messages mention me, unread" without
 *  a GIN scan per agent, and cascades cleanly when an agent is deleted. */
export const messageMentions = pgTable(
  "message_mentions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // Mentioning `@scout` twice in one message is one mention, and
    // makes mention→run creation idempotent on retry.
    uniqueIndex("uq_message_mentions").on(table.messageId, table.agentId),
    index("idx_message_mentions_agent").on(table.agentId, table.createdAt),
  ],
);

// --- Runs ---

/** One mention → one run. The unit that gets injected, budgeted, and
 *  summarised as a collapsed turn in the transcript. */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** NULL for runs created outside a channel (manual inject, schedule
     *  without a target channel). */
    channelId: uuid("channel_id").references(() => channels.id, { onDelete: "cascade" }),
    triggerMessageId: uuid("trigger_message_id").references((): AnyPgColumn => messages.id, {
      onDelete: "set null",
    }),
    /** Exactly one requester in practice (human mention or agent
     *  dispatch), but left unconstrained: scheduler-created runs have
     *  neither. */
    requesterUserId: text("requester_user_id").references(() => user.id, { onDelete: "set null" }),
    requesterAgentId: uuid("requester_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    prompt: text("prompt").notNull(),
    injectionMode: injectionModeEnum("injection_mode").notNull().default("queue"),
    status: runStatusEnum("status").notNull().default("queued"),
    queuedAt: timestamp("queued_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    /** Feeds the collapsed turn summary ("8 tool calls · 31s · 9.4k
     *  tokens") without counting `agent_events` rows on every render. */
    toolCallCount: integer("tool_call_count").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // The drainer's hot path: oldest queued run per agent, released when
    // the sidecar next reports idle. Partial so it stays tiny — queued
    // rows are a handful at any moment, finished ones are forever.
    index("idx_runs_queued")
      .on(table.agentId, table.queuedAt)
      .where(sql`status = 'queued'`),
    index("idx_runs_agent_created").on(table.agentId, table.createdAt),
    index("idx_runs_channel_created").on(table.channelId, table.createdAt),
    index("idx_runs_status").on(table.status),
  ],
);

/** Agent→agent gate. A mention from an agent creates one of these plus a
 *  `kind='dispatch_request'` message (the card); nothing is injected
 *  until a human approves — unless the channel has auto-approve on, in
 *  which case the row is still written, already resolved. */
export const dispatchRequests = pgTable(
  "dispatch_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    fromAgentId: uuid("from_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toAgentId: uuid("to_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    /** Set by "Edit & approve". NULL means the original prompt was
     *  approved verbatim. */
    approvedPrompt: text("approved_prompt"),
    status: dispatchStatusEnum("status").notNull().default("pending"),
    /** NULL with status='approved' means the channel's auto-approve
     *  resolved it, not a person. */
    decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at"),
    expiresAt: timestamp("expires_at").notNull(),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    createdRunId: uuid("created_run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // Sweeper scan. Partial: only pending cards can expire, and the
    // resolved ones are the ones that accumulate.
    index("idx_dispatch_pending_expiry")
      .on(table.expiresAt)
      .where(sql`status = 'pending'`),
    index("idx_dispatch_channel_created").on(table.channelId, table.createdAt),
    index("idx_dispatch_to_agent").on(table.toAgentId, table.status),
  ],
);

// --- Sidecar ingest ---

/** Raw sidecar stream — the source of truth the transcript is projected
 *  from. Append-only. */
export const agentEvents = pgTable(
  "agent_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    /** Sidecar-assigned ordering counter. Monotonic within one sidecar
     *  process only — it restarts at 0 when the container restarts,
     *  which is exactly why it is NOT the idempotency key. */
    seq: bigint("seq", { mode: "number" }).notNull(),
    /** The idempotency key. Claude Code stamps a `uuid` per JSONL line —
     *  use it, falling back to `sha1(path + offset)`. Ingest is
     *  `ON CONFLICT DO NOTHING` on the unique index below, so retries,
     *  container restarts, and offset rewinds all collapse harmlessly. */
    sourceRef: text("source_ref").notNull(),
    type: agentEventTypeEnum("type").notNull(),
    /** Tool-call rows carry glyph/verb/target/meta (or enough to derive
     *  them) so the client never re-parses raw tool input. Full tool
     *  inputs are never stored — digest plus a ~2KB preview, truncated
     *  server-side as well as in the sidecar. */
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // THE idempotency guarantee for sidecar ingest. Note this is
    // (agent_id, source_ref), not (agent_id, seq): seq resets on sidecar
    // restart, so a seq-keyed unique would silently swallow genuinely
    // new events after every container bounce.
    uniqueIndex("uq_agent_events_source").on(table.agentId, table.sourceRef),
    // Transcript render order.
    index("idx_agent_events_run_seq").on(table.runId, table.seq),
    index("idx_agent_events_agent_seq").on(table.agentId, table.seq),
  ],
);

/** Inline result/file/link cards in the transcript. `submit-result.sh`
 *  posts one of these instead of writing `coding_sessions.result_html`. */
export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** The card in the transcript. Set once the message is written. */
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    kind: artifactKindEnum("kind").notNull().default("html"),
    title: text("title"),
    contentType: text("content_type"),
    /** Inline payload for `html`/`text` artifacts. */
    body: text("body"),
    /** External location for `link`/`file` artifacts. */
    url: text("url"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_artifacts_channel_created").on(table.channelId, table.createdAt),
    index("idx_artifacts_agent").on(table.agentId),
    index("idx_artifacts_message").on(table.messageId),
  ],
);

// --- Egress ---

/** The `host · scope · added by` table from Settings, and authoritative
 *  at connect time. An agent's effective allowlist is the union of
 *  workspace-scoped rules, rules scoped to its blueprint, and rules
 *  scoped to itself. */
export const egressRules = pgTable(
  "egress_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Exact host, or `.suffix` for a wildcard. Stored lowercase and
     *  punycode-encoded by the API layer so the matcher stays a pure
     *  string comparison. */
    host: text("host").notNull(),
    scope: egressScopeEnum("scope").notNull().default("workspace"),
    /** The plan wrote scope as a composite string (`blueprint:<id>`);
     *  split into enum + FK so deleting a blueprint or agent takes its
     *  rules with it, and so the union query is indexable. */
    blueprintId: uuid("blueprint_id").references(() => agentBlueprints.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    addedByUserId: text("added_by_user_id").references(() => user.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // Keeps scope and target honest: a 'workspace' rule that also
    // carries an agent_id would widen far more than the UI shows.
    check(
      "egress_rules_scope_target",
      sql`(
        (${table.scope} = 'workspace' AND ${table.blueprintId} IS NULL AND ${table.agentId} IS NULL)
        OR (${table.scope} = 'blueprint' AND ${table.blueprintId} IS NOT NULL AND ${table.agentId} IS NULL)
        OR (${table.scope} = 'agent' AND ${table.agentId} IS NOT NULL AND ${table.blueprintId} IS NULL)
      )`,
    ),
    // One rule per host per scope target. Partial, for the same
    // NULLs-are-distinct reason as channel_members.
    uniqueIndex("uq_egress_rules_workspace_host")
      .on(table.host)
      .where(sql`scope = 'workspace'`),
    uniqueIndex("uq_egress_rules_blueprint_host")
      .on(table.blueprintId, table.host)
      .where(sql`scope = 'blueprint'`),
    uniqueIndex("uq_egress_rules_agent_host")
      .on(table.agentId, table.host)
      .where(sql`scope = 'agent'`),
    index("idx_egress_rules_scope").on(table.scope),
  ],
);

// --- Schedules ---

/** Polled by a single in-process interval — deliberately not a
 *  distributed job queue; this is a single-instance harness. */
export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    name: text("name"),
    cron: text("cron").notNull(),
    /** IANA zone the cron is evaluated in. "0 9 * * *" means nothing
     *  without one, and UTC-only schedules surprise everyone twice a
     *  year. */
    timezone: text("timezone").notNull().default("UTC"),
    prompt: text("prompt").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at"),
    lastRunAt: timestamp("last_run_at"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // The poller's only query: due-and-enabled, ordered by due time.
    index("idx_schedules_due")
      .on(table.nextRunAt)
      .where(sql`enabled = true`),
    index("idx_schedules_agent").on(table.agentId),
  ],
);

// --- Inferred types ---

export type AgentBlueprint = typeof agentBlueprints.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type ChannelMember = typeof channelMembers.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MessageMention = typeof messageMentions.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type DispatchRequest = typeof dispatchRequests.$inferSelect;
export type AgentEvent = typeof agentEvents.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type EgressRule = typeof egressRules.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
export type DockerConfig = typeof dockerConfigs.$inferSelect;
export type User = typeof user.$inferSelect;

// --- Value unions (client-safe; these mirror the pg enums above) ---

export const AGENT_STATUSES = ["creating", "running", "stopped", "error", "destroyed"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_ACTIVITIES = ["idle", "busy", "unknown"] as const;
export type AgentActivity = (typeof AGENT_ACTIVITIES)[number];

export const AGENT_CLIS = ["claude-code", "codex", "antigravity", "custom"] as const;
export type AgentCli = (typeof AGENT_CLIS)[number];

export const SANDBOX_RUNTIMES = ["auto", "runc", "runsc", "kata"] as const;
export type SandboxRuntime = (typeof SANDBOX_RUNTIMES)[number];

export const EGRESS_POLICIES = ["none", "allowlist", "open"] as const;
export type EgressPolicy = (typeof EGRESS_POLICIES)[number];

export const EGRESS_SCOPES = ["workspace", "blueprint", "agent"] as const;
export type EgressScope = (typeof EGRESS_SCOPES)[number];

export const MESSAGE_KINDS = ["text", "event", "artifact", "dispatch_request", "system"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const MESSAGE_AUTHOR_KINDS = ["user", "agent", "system"] as const;
export type MessageAuthorKind = (typeof MESSAGE_AUTHOR_KINDS)[number];

export const INJECTION_MODES = ["queue", "interrupt"] as const;
export type InjectionMode = (typeof INJECTION_MODES)[number];

export const RUN_STATUSES = [
  "queued",
  "injecting",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const DISPATCH_STATUSES = ["pending", "approved", "denied", "expired"] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export const AGENT_EVENT_TYPES = [
  "turn_start",
  "assistant_text",
  "tool_use",
  "tool_result",
  "turn_end",
  "status",
  "usage",
  "raw",
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export const ARTIFACT_KINDS = ["html", "file", "link", "text"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const CHANNEL_MEMBER_ROLES = ["owner", "member"] as const;
export type ChannelMemberRole = (typeof CHANNEL_MEMBER_ROLES)[number];

export type UserRole = "admin" | "user";

// --- Relations ---

export const userRelations = relations(user, ({ many }) => ({
  agents: many(agents),
  blueprints: many(agentBlueprints),
  channels: many(channels),
  channelMemberships: many(channelMembers),
  messages: many(messages),
}));

export const agentBlueprintsRelations = relations(agentBlueprints, ({ one, many }) => ({
  creator: one(user, {
    fields: [agentBlueprints.createdBy],
    references: [user.id],
  }),
  agents: many(agents),
  egressRules: many(egressRules),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  blueprint: one(agentBlueprints, {
    fields: [agents.blueprintId],
    references: [agentBlueprints.id],
  }),
  owner: one(user, {
    fields: [agents.ownerId],
    references: [user.id],
  }),
  memberships: many(channelMembers),
  events: many(agentEvents),
  schedules: many(schedules),
  // Runs this agent executes, as opposed to runs it requested — the two
  // FKs point at the same table, so both sides need a relationName.
  runs: many(runs, { relationName: "runAgent" }),
  requestedRuns: many(runs, { relationName: "runRequester" }),
  dispatchesSent: many(dispatchRequests, { relationName: "dispatchFrom" }),
  dispatchesReceived: many(dispatchRequests, { relationName: "dispatchTo" }),
}));

export const channelsRelations = relations(channels, ({ one, many }) => ({
  creator: one(user, {
    fields: [channels.createdBy],
    references: [user.id],
  }),
  members: many(channelMembers),
  messages: many(messages),
  runs: many(runs),
  dispatchRequests: many(dispatchRequests),
  artifacts: many(artifacts),
  schedules: many(schedules),
}));

export const channelMembersRelations = relations(channelMembers, ({ one }) => ({
  channel: one(channels, {
    fields: [channelMembers.channelId],
    references: [channels.id],
  }),
  agent: one(agents, {
    fields: [channelMembers.agentId],
    references: [agents.id],
  }),
  user: one(user, {
    fields: [channelMembers.userId],
    references: [user.id],
  }),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  channel: one(channels, {
    fields: [messages.channelId],
    references: [channels.id],
  }),
  parent: one(messages, {
    fields: [messages.parentId],
    references: [messages.id],
    relationName: "messageThread",
  }),
  replies: many(messages, { relationName: "messageThread" }),
  authorUser: one(user, {
    fields: [messages.authorUserId],
    references: [user.id],
  }),
  authorAgent: one(agents, {
    fields: [messages.authorAgentId],
    references: [agents.id],
  }),
  run: one(runs, {
    fields: [messages.runId],
    references: [runs.id],
    relationName: "messageRun",
  }),
  mentionRows: many(messageMentions),
  artifacts: many(artifacts),
}));

export const messageMentionsRelations = relations(messageMentions, ({ one }) => ({
  message: one(messages, {
    fields: [messageMentions.messageId],
    references: [messages.id],
  }),
  agent: one(agents, {
    fields: [messageMentions.agentId],
    references: [agents.id],
  }),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  agent: one(agents, {
    fields: [runs.agentId],
    references: [agents.id],
    relationName: "runAgent",
  }),
  channel: one(channels, {
    fields: [runs.channelId],
    references: [channels.id],
  }),
  triggerMessage: one(messages, {
    fields: [runs.triggerMessageId],
    references: [messages.id],
    relationName: "runTrigger",
  }),
  requesterUser: one(user, {
    fields: [runs.requesterUserId],
    references: [user.id],
  }),
  requesterAgent: one(agents, {
    fields: [runs.requesterAgentId],
    references: [agents.id],
    relationName: "runRequester",
  }),
  events: many(agentEvents),
  messages: many(messages, { relationName: "messageRun" }),
}));

export const dispatchRequestsRelations = relations(dispatchRequests, ({ one }) => ({
  channel: one(channels, {
    fields: [dispatchRequests.channelId],
    references: [channels.id],
  }),
  fromAgent: one(agents, {
    fields: [dispatchRequests.fromAgentId],
    references: [agents.id],
    relationName: "dispatchFrom",
  }),
  toAgent: one(agents, {
    fields: [dispatchRequests.toAgentId],
    references: [agents.id],
    relationName: "dispatchTo",
  }),
  decidedByUser: one(user, {
    fields: [dispatchRequests.decidedBy],
    references: [user.id],
  }),
  message: one(messages, {
    fields: [dispatchRequests.messageId],
    references: [messages.id],
  }),
  createdRun: one(runs, {
    fields: [dispatchRequests.createdRunId],
    references: [runs.id],
  }),
}));

export const agentEventsRelations = relations(agentEvents, ({ one }) => ({
  agent: one(agents, {
    fields: [agentEvents.agentId],
    references: [agents.id],
  }),
  run: one(runs, {
    fields: [agentEvents.runId],
    references: [runs.id],
  }),
}));

export const artifactsRelations = relations(artifacts, ({ one }) => ({
  channel: one(channels, {
    fields: [artifacts.channelId],
    references: [channels.id],
  }),
  message: one(messages, {
    fields: [artifacts.messageId],
    references: [messages.id],
  }),
  agent: one(agents, {
    fields: [artifacts.agentId],
    references: [agents.id],
  }),
  run: one(runs, {
    fields: [artifacts.runId],
    references: [runs.id],
  }),
  createdByUser: one(user, {
    fields: [artifacts.createdByUserId],
    references: [user.id],
  }),
}));

export const egressRulesRelations = relations(egressRules, ({ one }) => ({
  blueprint: one(agentBlueprints, {
    fields: [egressRules.blueprintId],
    references: [agentBlueprints.id],
  }),
  agent: one(agents, {
    fields: [egressRules.agentId],
    references: [agents.id],
  }),
  addedByUser: one(user, {
    fields: [egressRules.addedByUserId],
    references: [user.id],
  }),
}));

export const schedulesRelations = relations(schedules, ({ one }) => ({
  agent: one(agents, {
    fields: [schedules.agentId],
    references: [agents.id],
  }),
  channel: one(channels, {
    fields: [schedules.channelId],
    references: [channels.id],
  }),
  creator: one(user, {
    fields: [schedules.createdBy],
    references: [user.id],
  }),
}));
