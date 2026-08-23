import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AGENT_RESOLV_CONF_TARGET,
  SEEDED_RESOLV_CONF_PATH,
  ensureAgentResolvConf,
  needsResolvConfMount,
  renderResolvConf,
  resetResolvConfCache,
  resolvConfMount,
  type HelperRun,
  type HelperRunner,
} from "../../server/agents/agent-resolv-conf.js";
import { buildAgentSpec } from "../../server/agents/lifecycle.js";
import { toCreateOptions } from "../../server/sandbox/docker-base.js";

/**
 * Regression cover for a failure proven only on a live gVisor host: an agent
 * under runsc had no DNS, so the CLI died on `api.anthropic.com: ETIMEOUT` and
 * took the container with it. `HostConfig.Dns` looked like the mitigation and
 * was inert — on a user-defined network Docker keeps 127.0.0.11 in resolv.conf
 * and demotes those servers to its own upstreams. The fix is a real resolv.conf
 * bind-mounted from the Docker host.
 *
 * No daemon exists in CI, so the helper container is injected. These assertions
 * are what stops the mount from being dropped, from leaking onto runtimes that
 * never had the problem, or from failing silently.
 */

const IMAGE = "blackhouse-claude-code:latest";

/** Records every helper run and returns a fixed exit code. */
function fakeHelper(exitCode: number | null): HelperRunner & { runs: HelperRun[] } {
  const runs: HelperRun[] = [];
  const runner = (async (run: HelperRun) => {
    runs.push(run);
    return exitCode;
  }) as HelperRunner & { runs: HelperRun[] };
  runner.runs = runs;
  return runner;
}

const originalDns = process.env.BLACKHOUSE_AGENT_DNS;
const originalOverride = process.env.BLACKHOUSE_AGENT_RESOLV_CONF;

beforeEach(() => {
  resetResolvConfCache();
});

afterEach(() => {
  resetResolvConfCache();
  if (originalDns === undefined) delete process.env.BLACKHOUSE_AGENT_DNS;
  else process.env.BLACKHOUSE_AGENT_DNS = originalDns;
  if (originalOverride === undefined) delete process.env.BLACKHOUSE_AGENT_RESOLV_CONF;
  else process.env.BLACKHOUSE_AGENT_RESOLV_CONF = originalOverride;
});

describe("needsResolvConfMount", () => {
  it("is the inverse of having a reachable embedded resolver", () => {
    expect(needsResolvConfMount("runsc")).toBe(true);
    expect(needsResolvConfMount("runc")).toBe(false);
    expect(needsResolvConfMount("kata")).toBe(false);
    expect(needsResolvConfMount(undefined)).toBe(false);
  });
});

describe("renderResolvConf", () => {
  it("writes one nameserver line per server and nothing else", () => {
    // No `search` and no `domain`: a suffix we cannot verify would be appended
    // to every lookup the agent makes.
    const text = renderResolvConf(["1.1.1.1", "8.8.8.8"]);
    expect(text).toContain("nameserver 1.1.1.1");
    expect(text).toContain("nameserver 8.8.8.8");
    expect(text).not.toMatch(/^search /m);
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("ensureAgentResolvConf — runtimes with embedded DNS", () => {
  it("adds no mount for runc, and never touches the daemon", async () => {
    // runc reaches 127.0.0.11 perfectly well. Replacing its resolv.conf would
    // cost container-name resolution — the thing the pinned aliases exist to
    // work around — for a runtime that never had the bug.
    const helper = fakeHelper(0);
    const plan = await ensureAgentResolvConf({
      runtime: "runc",
      image: IMAGE,
      runHelper: helper,
    });
    expect(plan.mount).toBeNull();
    expect(plan.warning).toBeUndefined();
    expect(helper.runs).toHaveLength(0);
  });
});

describe("ensureAgentResolvConf — seeding on the Docker host", () => {
  it("seeds the file and mounts it read-only over /etc/resolv.conf", async () => {
    const helper = fakeHelper(0);
    const plan = await ensureAgentResolvConf({
      runtime: "runsc",
      image: IMAGE,
      servers: ["1.1.1.1"],
      overridePath: null,
      runHelper: helper,
    });

    expect(plan.warning).toBeUndefined();
    expect(plan.mount).toEqual({
      source: SEEDED_RESOLV_CONF_PATH,
      target: AGENT_RESOLV_CONF_TARGET,
      readOnly: true,
    });

    expect(helper.runs).toHaveLength(1);
    const run = helper.runs[0];
    // The parent directory is bound, never the file: Docker creates a missing
    // bind source, and it creates it as a directory — at exactly the path we
    // would then mount over resolv.conf.
    expect(run.hostDir).toBe("/var/lib/blackhouse");
    expect(run.readOnly).toBe(false);
    expect(run.env.some((e) => e.startsWith("BH_TARGET=/bh-resolv/agent-resolv.conf"))).toBe(true);
    expect(run.env.some((e) => e.includes("nameserver 1.1.1.1"))).toBe(true);
    // Contents reach the shell through the environment, so a nameserver value
    // can never be interpolated into the script.
    expect(run.script).not.toContain("1.1.1.1");
  });

  it("runs one helper container however many agents start", async () => {
    const helper = fakeHelper(0);
    const call = () =>
      ensureAgentResolvConf({
        runtime: "runsc",
        image: IMAGE,
        servers: ["1.1.1.1"],
        overridePath: null,
        runHelper: helper,
      });
    await Promise.all([call(), call()]);
    await call();
    expect(helper.runs).toHaveLength(1);
  });

  it("warns loudly and adds no mount when seeding fails", async () => {
    const helper = fakeHelper(1);
    const plan = await ensureAgentResolvConf({
      runtime: "runsc",
      image: IMAGE,
      servers: ["1.1.1.1"],
      overridePath: null,
      runHelper: helper,
    });
    expect(plan.mount).toBeNull();
    expect(plan.warning).toMatch(/NO general DNS/);
    expect(plan.warning).toContain("BLACKHOUSE_AGENT_RESOLV_CONF");
  });

  it("retries a failed seed on the next start rather than caching the failure", async () => {
    // An operator who fixes the daemon-side problem expects the next start to
    // pick it up without restarting the harness.
    const failing = fakeHelper(1);
    expect(
      (
        await ensureAgentResolvConf({
          runtime: "runsc",
          image: IMAGE,
          servers: ["1.1.1.1"],
          overridePath: null,
          runHelper: failing,
        })
      ).mount,
    ).toBeNull();

    const working = fakeHelper(0);
    expect(
      (
        await ensureAgentResolvConf({
          runtime: "runsc",
          image: IMAGE,
          servers: ["1.1.1.1"],
          overridePath: null,
          runHelper: working,
        })
      ).mount?.source,
    ).toBe(SEEDED_RESOLV_CONF_PATH);
  });

  it("warns rather than seeding an empty resolver list", async () => {
    // `BLACKHOUSE_AGENT_DNS=""` is an opt-out. Seeding a resolv.conf with no
    // nameserver in it would be worse than leaving Docker's alone.
    const helper = fakeHelper(0);
    const plan = await ensureAgentResolvConf({
      runtime: "runsc",
      image: IMAGE,
      servers: [],
      overridePath: null,
      runHelper: helper,
    });
    expect(plan.mount).toBeNull();
    expect(plan.warning).toContain("BLACKHOUSE_AGENT_DNS");
    expect(helper.runs).toHaveLength(0);
  });
});

describe("ensureAgentResolvConf — operator override", () => {
  it("uses the operator's file when it exists on the Docker host", async () => {
    const helper = fakeHelper(0);
    const plan = await ensureAgentResolvConf({
      runtime: "runsc",
      image: IMAGE,
      overridePath: "/etc/blackhouse/resolv.conf",
      runHelper: helper,
    });
    expect(plan.mount?.source).toBe("/etc/blackhouse/resolv.conf");
    // Only looked at, never written: the operator's file is theirs.
    expect(helper.runs[0].readOnly).toBe(true);
    expect(helper.runs[0].hostDir).toBe("/etc/blackhouse");
  });

  it("warns and adds no mount when the operator's path is missing", async () => {
    // The path is read by the daemon, not by this container, so it cannot be
    // stat'd here — a missing file is only discoverable daemon-side, and
    // mounting it blind would put a Docker-created *directory* over resolv.conf.
    const helper = fakeHelper(1);
    const plan = await ensureAgentResolvConf({
      runtime: "runsc",
      image: IMAGE,
      overridePath: "/etc/blackhouse/resolv.conf",
      runHelper: helper,
    });
    expect(plan.mount).toBeNull();
    expect(plan.warning).toContain("/etc/blackhouse/resolv.conf");
    expect(plan.warning).toMatch(/missing or empty/);
  });

  it("refuses a relative path, which Docker would read as a named volume", async () => {
    const helper = fakeHelper(0);
    const plan = await ensureAgentResolvConf({
      runtime: "runsc",
      image: IMAGE,
      overridePath: "resolv.conf",
      runHelper: helper,
    });
    expect(plan.mount).toBeNull();
    expect(plan.warning).toContain("named volume");
    expect(helper.runs).toHaveLength(0);
  });

  it("reads BLACKHOUSE_AGENT_RESOLV_CONF when no path is passed", async () => {
    process.env.BLACKHOUSE_AGENT_RESOLV_CONF = "/srv/resolv.conf";
    const plan = await ensureAgentResolvConf({
      runtime: "runsc",
      image: IMAGE,
      runHelper: fakeHelper(0),
    });
    expect(plan.mount?.source).toBe("/srv/resolv.conf");
  });
});

// ---------------------------------------------------------------------------
// What the container actually gets
// ---------------------------------------------------------------------------

const agent = {
  id: "agent-1",
  handle: "scout",
  agentToken: "tok",
  workspaceVolume: "bh-ws-1",
  stateVolume: "bh-state-1",
  containerImage: IMAGE,
  egressPolicy: null,
  systemPromptOverride: null,
  gitRepoUrl: null,
  gitBranch: null,
} as unknown as Parameters<typeof buildAgentSpec>[0];

const blueprint = {
  id: "bp-1",
  cli: "claude-code",
  image: IMAGE,
  egressPolicy: "open",
  envVars: null,
  volumeMounts: null,
  stateMountPath: null,
  agentCommand: null,
  systemPrompt: null,
} as unknown as Parameters<typeof buildAgentSpec>[1];

describe("buildAgentSpec + toCreateOptions — the resolv.conf bind", () => {
  it("renders the read-only bind Docker needs", () => {
    const spec = buildAgentSpec(agent, blueprint, {
      blackhouseUrl: "http://app:3000",
      networkName: "blackhouse",
      resolvConfSource: SEEDED_RESOLV_CONF_PATH,
    });
    expect(spec.mounts).toContainEqual(resolvConfMount(SEEDED_RESOLV_CONF_PATH));

    const binds = (toCreateOptions(spec) as unknown as Record<string, any>).HostConfig.Binds;
    expect(binds).toContain(`${SEEDED_RESOLV_CONF_PATH}:${AGENT_RESOLV_CONF_TARGET}:ro`);
  });

  it("adds nothing when no source was established", () => {
    const spec = buildAgentSpec(agent, blueprint, {
      blackhouseUrl: "http://app:3000",
      networkName: "blackhouse",
    });
    expect(spec.mounts?.some((m) => m.target === AGENT_RESOLV_CONF_TARGET)).toBe(false);
  });
});
