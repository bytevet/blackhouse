import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A settings update writes what it was given and leaves the rest alone.
 *
 * Both of these routes used to build their `values` with `?? null`, which turns
 * "the caller did not mention this field" into "the caller wants this field
 * cleared". Every write then had to be a whole row, and any client that sent a
 * partial one silently destroyed the fields it omitted.
 *
 * It is not a theoretical failure. Setting a blueprint's egress policy through
 * the API nulled its `agentCommand`; the next agent started from that blueprint
 * came up with nothing to exec, the entrypoint refused to hand its PTY to a
 * shell, and the container exited. The write returned 200 the whole way.
 *
 * The docker route had the same shape plus a second bug: `egressEnforce` was
 * validated and then never copied into `values`, so the one switch that makes
 * an egress policy binding could be set, acknowledged, and dropped.
 *
 * These tests read the values handed to the database, because that is where
 * both bugs lived — the responses were 200 in every case.
 */

type Row = Record<string, unknown>;

const dbState = vi.hoisted(() => ({
  rows: {} as Record<string, Row[]>,
  /** The `values` of the last `update().set()`, per table. */
  updated: {} as Record<string, Row>,
  inserted: {} as Record<string, Row>,
}));

vi.mock("../../server/db/index.js", async () => {
  const { getTableName } = await import("drizzle-orm");
  return {
    db: {
      select: () => ({
        from: (table: never) => {
          const name = getTableName(table);
          const builder = {
            where: () => builder,
            limit: () => builder,
            orderBy: () => builder,
            leftJoin: () => builder,
            then: (ok: (r: Row[]) => unknown, fail?: (e: unknown) => unknown) =>
              Promise.resolve(dbState.rows[name] ?? []).then(ok, fail),
          };
          return builder;
        },
      }),
      update: (table: never) => {
        const name = getTableName(table);
        return {
          set: (values: Row) => {
            dbState.updated[name] = values;
            return {
              where: () => ({
                returning: () =>
                  Promise.resolve([{ ...(dbState.rows[name]?.[0] ?? {}), ...values }]),
              }),
            };
          },
        };
      },
      insert: (table: never) => {
        const name = getTableName(table);
        return {
          values: (values: Row) => {
            dbState.inserted[name] = values;
            return { returning: () => Promise.resolve([values]) };
          },
        };
      },
    },
  };
});

vi.mock("../../server/middleware/auth.js", async () => {
  const { createMiddleware } = await import("hono/factory");
  const inject = createMiddleware(async (c, next) => {
    c.set("session", { user: { id: "u-admin", role: "admin" } });
    await next();
  });
  return { authMiddleware: inject, adminMiddleware: inject };
});

// Writing docker config resets the cached client; there is no daemon here.
vi.mock("../../server/lib/docker.js", () => ({
  resetDockerClient: () => {},
  getDockerClient: async () => {
    throw new Error("no daemon in unit tests");
  },
}));

const settingsApp = (await import("../../server/api/settings.js")).default;

const BP = "276dfdcb-1ecb-4273-b813-b74c46f4c169";

const blueprint = (over: Partial<Row> = {}): Row => ({
  id: BP,
  name: "Claude Code",
  cli: "claude-code",
  agentCommand: "claude --dangerously-skip-permissions",
  envVars: [{ key: "FOO", value: "bar" }],
  volumeMounts: null,
  dockerfileContent: "FROM node:22",
  egressPolicy: "open",
  egressAllowlist: null,
  enableIde: false,
  enableBrowser: false,
  ...over,
});

beforeEach(() => {
  dbState.rows = {};
  dbState.updated = {};
  dbState.inserted = {};
});

describe("PUT /settings/blueprints/:id", () => {
  it("leaves out of the write what the payload left out", async () => {
    dbState.rows["agent_blueprints"] = [blueprint()];

    const res = await settingsApp.request(`/blueprints/${BP}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      // The exact payload that broke the deployment: a policy change that
      // mentions neither the start command nor anything else.
      body: JSON.stringify({
        cli: "claude-code",
        name: "Claude Code",
        egressPolicy: "allowlist",
        egressAllowlist: ["api.anthropic.com"],
      }),
    });

    expect(res.status).toBe(200);
    const written = dbState.updated["agent_blueprints"];
    expect(written.egressPolicy).toBe("allowlist");
    // The whole point: absent fields are absent from the UPDATE, so the column
    // keeps whatever it held. Present-and-null would clear it.
    expect(written).not.toHaveProperty("agentCommand");
    expect(written).not.toHaveProperty("envVars");
    expect(written).not.toHaveProperty("dockerfileContent");
  });

  it("still clears a field that is explicitly null", async () => {
    dbState.rows["agent_blueprints"] = [blueprint()];

    await settingsApp.request(`/blueprints/${BP}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      // `dockerfileContent` is the nullable one — `agentCommand` is
      // `.optional()` without `.nullable()`, so the schema rejects an explicit
      // null there and omission is the only way to leave it be.
      body: JSON.stringify({ cli: "claude-code", name: "Claude Code", dockerfileContent: null }),
    });

    // Omission and erasure have to stay distinguishable, or "leave it alone"
    // would mean a field could never be cleared.
    expect(dbState.updated["agent_blueprints"]).toHaveProperty("dockerfileContent", null);
  });
});

describe("PUT /settings/docker", () => {
  it("persists egressEnforce", async () => {
    dbState.rows["docker_configs"] = [
      { id: 1, socketPath: "/var/run/docker.sock", egressEnforce: false },
    ];

    const res = await settingsApp.request("/docker", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ egressEnforce: true }),
    });

    expect(res.status).toBe(200);
    // This assertion is the whole reason the switch exists. It was accepted and
    // discarded before: validated by the schema, never copied into the write.
    expect(dbState.updated["docker_configs"]).toHaveProperty("egressEnforce", true);
  });

  it("does not clear the daemon host or its TLS material", async () => {
    dbState.rows["docker_configs"] = [
      {
        id: 1,
        socketPath: null,
        host: "docker-e2e.example",
        port: 443,
        tlsCa: "ca",
        tlsCert: "cert",
        tlsKey: "key",
      },
    ];

    await settingsApp.request("/docker", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ egressEnforce: true }),
    });

    const written = dbState.updated["docker_configs"];
    for (const field of ["host", "port", "tlsCa", "tlsCert", "tlsKey", "socketPath"]) {
      expect(written, `${field} should be untouched`).not.toHaveProperty(field);
    }
  });
});

describe("GET /settings/docker", () => {
  it("never returns the daemon client key", async () => {
    dbState.rows["docker_configs"] = [
      { id: 1, socketPath: null, host: "docker-e2e.example", tlsCert: "cert", tlsKey: "SECRET" },
    ];

    const res = await settingsApp.request("/docker");
    const body = await res.text();

    // A Docker daemon is root on its host. The key is the one value in this
    // table that must not leave the server, and it was leaving on every load.
    expect(body).not.toContain("SECRET");
    expect(JSON.parse(body)).not.toHaveProperty("tlsKey");
    expect(JSON.parse(body)).toHaveProperty("hasTlsKey", true);
  });
});
