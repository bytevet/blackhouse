import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Channel membership is now a gate, and a gate is only as good as the case it
 * lets through. Two failure modes are worth a test each:
 *
 *  - **Closing too far.** Every channel on the live deployment is public and
 *    has zero human members — `server/db/seed.ts` creates `#general` and adds
 *    nobody — so a read check that consults membership before it checks
 *    `isPrivate` locks every user out of every room the moment it ships,
 *    including whoever shipped it. There is no partial version of that outage.
 *  - **Not closing at all.** A private channel whose SSE frames anyone can
 *    subscribe to leaks who is talking and when, which is most of what makes
 *    it private.
 *
 * There is no database here, and there is none in CI either, so `db` is
 * replaced with a fake that answers each query with rows the test names. That
 * models the *result* of a query rather than a table, which is honest for the
 * membership lookups: their user filter lives in SQL, so "these rows come
 * back" is exactly "this user is in these channels".
 *
 * The fake ignores predicates, so it cannot see the SQL. A membership query
 * that lost its `userId` filter would still pass here. That gap is the price
 * of having no Postgres, and it is why the migration at the bottom of this
 * file is asserted textually rather than executed.
 */

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  /** Rows every SELECT against a table resolves to, keyed by SQL table name. */
  rows: {} as Record<string, Row[]>,
  calls: [] as Array<{ op: "select" | "insert" | "update"; table: string; values?: Row[] }>,
  seq: 0,
}));

const session = vi.hoisted(() => ({
  user: { id: "u-alice", role: "user" } as { id: string; role?: string | null },
}));

vi.mock("../../server/db/index.js", async () => {
  const { getTableName } = await import("drizzle-orm");

  const select = (table: string) => {
    dbState.calls.push({ op: "select", table });
    const builder = {
      where: () => builder,
      limit: () => builder,
      orderBy: () => builder,
      then: (ok: (r: Row[]) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve(dbState.rows[table] ?? []).then(ok, fail),
    };
    return builder;
  };

  return {
    db: {
      select: () => ({ from: (table: never) => select(getTableName(table)) }),
      insert: (table: never) => {
        const name = getTableName(table);
        return {
          values: (values: Row | Row[]) => {
            const list = Array.isArray(values) ? values : [values];
            dbState.calls.push({ op: "insert", table: name, values: list });
            // Enough of a row for the caller to read an id back off it.
            const inserted = list.map((v) => ({ id: `${name}-${++dbState.seq}`, ...v }));
            return {
              returning: () => Promise.resolve(inserted),
              then: (ok: (r: Row[]) => unknown, fail?: (e: unknown) => unknown) =>
                Promise.resolve(inserted).then(ok, fail),
            };
          },
        };
      },
      update: (table: never) => {
        const name = getTableName(table);
        return {
          set: () => ({
            where: () => {
              dbState.calls.push({ op: "update", table: name });
              return Promise.resolve([]);
            },
          }),
        };
      },
    },
  };
});

vi.mock("../../server/middleware/auth.js", async () => {
  const { createMiddleware } = await import("hono/factory");
  const inject = createMiddleware(async (c, next) => {
    c.set("session", { user: session.user });
    await next();
  });
  return { authMiddleware: inject, adminMiddleware: inject };
});

// Injection is not what these tests are about; without this the dispatch path
// would try to talk to a container.
const deliverRun = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../server/agents/queue.js", () => ({ deliverRun }));

const { channelAccess } = await import("../../server/api/channels.js");
const channelsApp = (await import("../../server/api/channels.js")).default;
const streamApp = (await import("../../server/api/stream.js")).default;

const PUBLIC = "11111111-1111-1111-1111-111111111111";
const PRIVATE = "22222222-2222-2222-2222-222222222222";
const AGENT = "33333333-3333-3333-3333-333333333333";

const channel = (over: Partial<Row> = {}) =>
  ({
    id: PUBLIC,
    slug: "general",
    name: "general",
    isPrivate: false,
    isArchived: false,
    ...over,
  }) as never;

const alice = { id: "u-alice", role: "user" };
const admin = { id: "u-admin", role: "admin" };

beforeEach(() => {
  dbState.rows = {};
  dbState.calls = [];
  dbState.seq = 0;
  session.user = alice;
  deliverRun.mockClear();
});

describe("channelAccess — the public short-circuit", () => {
  it("lets a non-member read a public channel with no members at all", async () => {
    // The deployed state: `#general`, public, zero rows in `channel_members`.
    // If this ever fails, every user is locked out of every room.
    dbState.rows["channel_members"] = [];

    const access = await channelAccess(channel(), alice);

    expect(access.canRead).toBe(true);
    expect(access.isMember).toBe(false);
  });

  it("lets a non-member read a public channel that other people are in", async () => {
    // The variant the first test cannot catch: a check written as
    // `isMember || !isPrivate` still passes on an empty table by accident.
    // Here membership exists and is somebody else's, so a read decision that
    // consults it before `isPrivate` returns false.
    dbState.rows["channel_members"] = [{ agentId: null, userId: "u-bob" }];

    const access = await channelAccess(channel(), alice);

    expect(access.canRead).toBe(true);
    expect(access.isMember).toBe(false);
  });
});

describe("channelAccess — private channels", () => {
  it("hides a private channel from a non-member", async () => {
    dbState.rows["channel_members"] = [{ agentId: null, userId: "u-bob" }];

    const access = await channelAccess(channel({ id: PRIVATE, isPrivate: true }), alice);

    expect(access.canRead).toBe(false);
  });

  it("opens a private channel to its members", async () => {
    dbState.rows["channel_members"] = [{ agentId: null, userId: "u-alice" }];

    const access = await channelAccess(channel({ id: PRIVATE, isPrivate: true }), alice);

    expect(access.canRead).toBe(true);
    expect(access.isMember).toBe(true);
  });

  it("lets an admin in without a membership row", async () => {
    // Admins override everywhere else in this codebase, and a private room an
    // admin cannot see is a room an admin cannot administer.
    dbState.rows["channel_members"] = [];

    const access = await channelAccess(channel({ id: PRIVATE, isPrivate: true }), admin);

    expect(access.canRead).toBe(true);
    expect(access.isMember).toBe(false);
  });
});

describe("channelAccess — the two subjects stay separate", () => {
  it("collects agent ids and never mistakes a human row for one", async () => {
    // `agentIds` is what mention gating filters against. A human id landing in
    // it would make a human's membership summon an agent that is not there —
    // and an agent row counted as `isMember` would open a private channel to
    // whoever shares a channel with a bot.
    dbState.rows["channel_members"] = [
      { agentId: AGENT, userId: null },
      { agentId: null, userId: "u-bob" },
    ];

    const access = await channelAccess(channel(), alice);

    expect([...access.agentIds]).toEqual([AGENT]);
    expect(access.isMember).toBe(false);
  });

  it("reports membership only for the caller", async () => {
    dbState.rows["channel_members"] = [
      { agentId: null, userId: "u-bob" },
      { agentId: null, userId: "u-alice" },
    ];

    expect((await channelAccess(channel(), alice)).isMember).toBe(true);
    expect((await channelAccess(channel(), { id: "u-carol", role: "user" })).isMember).toBe(false);
  });
});

/** Rows shaped like the agents a mention resolves to. */
const agentRow = (id: string, handle: string) => ({
  id,
  handle,
  status: "running",
  containerId: "c1",
  activity: "idle",
  pausedAt: null,
});

const post = (body: string) =>
  channelsApp.request("/general/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });

describe("mention gating — membership decides who can be summoned", () => {
  it("dispatches the member and reports the rest", async () => {
    // Before this, mentions resolved against every agent in the workspace,
    // which made the roster decorative. The failure it replaces is worse than
    // it looks: a mention of a non-member used to land, dispatch, and answer
    // in a channel nobody had put the agent in.
    dbState.rows["channels"] = [channel()];
    dbState.rows["channel_members"] = [{ agentId: AGENT, userId: null }];
    dbState.rows["agents"] = [agentRow(AGENT, "scout"), agentRow("a-outsider", "warden")];

    const res = await post("@scout @warden please look");
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      dispatched: Array<{ agentId: string }>;
      notMembers: string[];
      message: { mentions: string[] };
    };

    expect(json.dispatched.map((d) => d.agentId)).toEqual([AGENT]);
    expect(json.notMembers).toEqual(["warden"]);
    // The stored message must agree with the dispatch, or the transcript
    // renders a mention pill for an agent that was never told.
    expect(json.message.mentions).toEqual([AGENT]);
    expect(deliverRun).toHaveBeenCalledTimes(1);
  });

  it("still posts the message when every mention was a non-member", async () => {
    // Refusing the post would lose what someone typed over a membership detail
    // they can fix in two clicks; `notMembers` is how the composer explains it.
    dbState.rows["channels"] = [channel()];
    dbState.rows["channel_members"] = [];
    dbState.rows["agents"] = [agentRow("a-outsider", "warden")];

    const res = await post("@warden ping");
    expect(res.status).toBe(201);
    const json = (await res.json()) as { dispatched: unknown[]; notMembers: string[] };

    expect(json.dispatched).toEqual([]);
    expect(json.notMembers).toEqual(["warden"]);
    expect(deliverRun).not.toHaveBeenCalled();
    // No mention rows either — a run that never happened must not be recorded.
    expect(dbState.calls.some((call) => call.table === "message_mentions")).toBe(false);
  });

  it("refuses a post to a private channel with 404, not 403", async () => {
    // A private channel should not confirm it exists. This also pins that the
    // gate is wired into the route rather than merely exported from the module.
    dbState.rows["channels"] = [channel({ id: PRIVATE, isPrivate: true })];
    dbState.rows["channel_members"] = [];

    const res = await post("hello");

    expect(res.status).toBe(404);
    expect(dbState.calls.some((call) => call.op === "insert")).toBe(false);
  });
});

/** Read the first SSE frame — the `ready` payload naming the live topics. */
async function readyTopics(res: Response): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (!buffered.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  const payload = /^data: (.*)$/m.exec(buffered)?.[1];
  return JSON.parse(payload ?? "{}").topics ?? [];
}

const stream = (topics: string) => streamApp.request(`/?topics=${topics}`);

describe("SSE topics — unauthorized ones are dropped, not rejected", () => {
  it("keeps a public channel topic for someone who is not a member", async () => {
    // Same live-deployment argument as `channelAccess`: gate the stream on
    // membership and every open tab stops receiving its own channel.
    dbState.rows["channels"] = [{ id: PUBLIC, isPrivate: false }];

    const res = await stream(`workspace,channel:${PUBLIC}`);

    expect(res.status).toBe(200);
    expect(await readyTopics(res)).toEqual(["workspace", `channel:${PUBLIC}`]);
  });

  it("drops a private channel topic while the rest of the connection survives", async () => {
    // The whole point of dropping rather than rejecting: a tab that asks for a
    // room it just lost access to keeps its `workspace` frames — the rail and
    // the roster stay live instead of the tab going dark.
    dbState.rows["channels"] = [
      { id: PUBLIC, isPrivate: false },
      { id: PRIVATE, isPrivate: true },
    ];
    dbState.rows["channel_members"] = [];

    const res = await stream(`workspace,channel:${PUBLIC},channel:${PRIVATE},agent:${AGENT}`);

    expect(res.status).toBe(200);
    expect(await readyTopics(res)).toEqual(["workspace", `channel:${PUBLIC}`, `agent:${AGENT}`]);
  });

  it("keeps a private channel topic for a member", async () => {
    dbState.rows["channels"] = [{ id: PRIVATE, isPrivate: true }];
    dbState.rows["channel_members"] = [{ channelId: PRIVATE }];

    expect(await readyTopics(await stream(`channel:${PRIVATE}`))).toEqual([`channel:${PRIVATE}`]);
  });

  it("lets an admin subscribe without touching the tables", async () => {
    // The admin bypass returns before any lookup, so an admin with a hundred
    // topics open costs nothing. Both halves matter: the topics survive, and
    // no query ran to decide it.
    session.user = admin;
    dbState.rows["channels"] = [{ id: PRIVATE, isPrivate: true }];

    expect(await readyTopics(await stream(`channel:${PRIVATE}`))).toEqual([`channel:${PRIVATE}`]);
    expect(dbState.calls).toEqual([]);
  });

  it("falls back to workspace when everything asked for was dropped", async () => {
    // An empty topic list would subscribe the connection to nothing and hold
    // it open forever — a live socket that can never deliver a frame.
    dbState.rows["channels"] = [{ id: PRIVATE, isPrivate: true }];
    dbState.rows["channel_members"] = [];

    expect(await readyTopics(await stream(`channel:${PRIVATE}`))).toEqual(["workspace"]);
  });
});

/**
 * The backfill runs once, on somebody's live database, unattended — and
 * `migrate.ts` throws on failure, so a bad one keeps the server from booting.
 * These assertions are source-level because there is no Postgres to run the
 * statement against; they cover the properties that would be expensive to
 * discover in production.
 */
describe("0001_backfill_channel_agents", () => {
  const sql = readFileSync(join("drizzle", "0001_backfill_channel_agents.sql"), "utf8");

  it("is registered in the journal", () => {
    // A migration file that no journal entry names is a file that never runs.
    // Mentions would then enforce membership against a table nobody populated,
    // and every existing channel would lose every agent in it.
    const journal = JSON.parse(readFileSync(join("drizzle", "meta", "_journal.json"), "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    expect(journal.entries.map((e) => e.tag)).toContain("0001_backfill_channel_agents");
  });

  it("puts every agent in every channel", () => {
    expect(sql).toMatch(/INSERT INTO channel_members \(channel_id, agent_id\)/i);
    expect(sql).toMatch(/CROSS JOIN/i);
  });

  it("skips destroyed agents", () => {
    // A destroyed agent cannot be mentioned; backfilling it only clutters
    // every roster with members nobody can remove usefully.
    expect(sql).toMatch(/status\s*<>\s*'destroyed'/i);
  });

  it("is idempotent", () => {
    // The partial unique index on (channel_id, agent_id) rejects a duplicate,
    // and one duplicate aborts the whole statement. Without ON CONFLICT the
    // migration fails on any database where somebody already added an agent to
    // a channel by hand — and a failed migration is a server that will not start.
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/i);
  });

  it("does not invent human memberships", () => {
    // Nothing gates on human membership except private channels, of which
    // there are none. Adding every user to every channel would fabricate state
    // rather than preserve it, and the unread pills would all light up.
    expect(sql).not.toMatch(/user_id/i);
  });
});

describe("the creator joins their own channel", () => {
  const source = () => readFileSync(join("server", "api", "channels.ts"), "utf8");

  it("writes a membership row on create, not just `createdBy`", () => {
    // Without this, a private channel is created with no members — and the
    // first person locked out is whoever just made it. Reproduced against the
    // deployment: 404 on their own room, absent from their own channel list,
    // and no delete endpoint to undo it.
    const create = source().slice(source().indexOf('.post("/", authMiddleware'));
    const body = create.slice(0, create.indexOf('.get("/:key"'));
    expect(body).toContain("schema.channelMembers");
    expect(body).toMatch(/role:\s*"owner"/);
  });

  it("is repaired for channels that already exist", () => {
    const sql = readFileSync(join("drizzle", "0002_backfill_channel_creators.sql"), "utf8");
    expect(sql).toContain("INSERT INTO channel_members");
    // `created_by` is nullable and `ON DELETE SET NULL`, so a room whose
    // creator was deleted has no one to add. Inserting NULL would violate the
    // table's "exactly one of agent/user" check.
    expect(sql).toContain("created_by IS NOT NULL");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
  });

  it("is registered in the journal", () => {
    const journal = JSON.parse(readFileSync(join("drizzle", "meta", "_journal.json"), "utf8"));
    expect(journal.entries.map((e: { tag: string }) => e.tag)).toContain(
      "0002_backfill_channel_creators",
    );
  });
});

describe("a private channel keeps at least one person", () => {
  const source = () => readFileSync(join("server", "api", "channels.ts"), "utf8");

  it("refuses to remove the last human from a private channel", () => {
    // The second lockout of this shape. The first was creation — a channel with
    // no members nobody could open. This is the same hole through removal: a
    // user removed themselves as the only member, got `200 {"ok":true}`, and the
    // room became unreachable and unremovable in one click. There is no
    // `DELETE /api/channels`, so the only way back is an admin or SQL.
    const del = source().slice(source().indexOf('.delete("/:key/members/:memberId"'));
    const body = del.slice(0, del.indexOf(".post(") > 0 ? del.indexOf(".post(") : del.length);
    expect(body).toContain("channel.isPrivate");
    expect(body).toContain("isNotNull(schema.channelMembers.userId)");
    expect(body).toMatch(/people\.length <= 1/);
    expect(body).toContain("409");
  });

  it("leaves public channels alone", () => {
    // An empty public channel is merely empty — anyone can still read it — so
    // the guard must not fire there, or leaving a room becomes impossible.
    const del = source().slice(source().indexOf('.delete("/:key/members/:memberId"'));
    expect(del.slice(0, 2000)).toMatch(/if \(channel\.isPrivate\)/);
  });

  it("warns in the dialog before the click, not after", () => {
    const dialog = readFileSync(join("src", "components", "channel", "members-dialog.tsx"), "utf8");
    expect(dialog).toContain("A private channel needs at least one person");
    expect(dialog).toMatch(/disabled=\{busy \|\| Boolean\(blocked\)\}/);
  });
});
