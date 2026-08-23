/**
 * Egress policy plumbing: the sharing key, the proxy environment, the
 * enforcement gate, and how all three land in a `SandboxSpec`.
 *
 * Everything under test here is pure. No Docker daemon exists in CI or in the
 * dev container, so the parts that talk to dockerode (`ensureEgressNetwork`,
 * `ensureProxyContainer`) are deliberately not exercised — what *is* testable,
 * and what actually decides whether an agent is contained, is the reasoning
 * that runs before those calls.
 */

import { describe, it, expect } from "vitest";
import { policyKeyFor, POLICY_KEY_NONE, POLICY_KEY_OPEN } from "../../server/egress/rules.js";
import {
  egressNetworkName,
  proxyContainerName,
  proxyEnvForAgent,
  PROXY_ALIAS,
  PROXY_PORT,
} from "../../server/egress/proxy-manager.js";
import { evaluateEnforcement, harnessHostname } from "../../server/egress/attach.js";
import type { EgressAttachment } from "../../server/egress/attach.js";
import { buildAgentSpec } from "../../server/agents/lifecycle.js";

// ---------------------------------------------------------------------------
// Policy key — what decides whether two agents share a proxy
// ---------------------------------------------------------------------------

describe("policyKeyFor", () => {
  it("is invariant to the things that do not change the policy", () => {
    const key = policyKeyFor(["api.anthropic.com", ".github.com"]);
    expect(policyKeyFor([".github.com", "api.anthropic.com"])).toBe(key); // order
    expect(policyKeyFor(["API.Anthropic.com", ".GitHub.com"])).toBe(key); // case
    expect(policyKeyFor(["api.anthropic.com", ".github.com", "api.anthropic.com"])).toBe(key); // dupes
    expect(policyKeyFor(["api.anthropic.com", "*.github.com"])).toBe(key); // wildcard spelling
  });

  it("folds punycode and unicode spellings of one host together", () => {
    expect(policyKeyFor(["münchen.de"])).toBe(policyKeyFor(["xn--mnchen-3ya.de"]));
  });

  it("separates policies that differ in any real way", () => {
    const base = policyKeyFor(["example.com"]);
    expect(policyKeyFor(["example.com", "other.com"])).not.toBe(base);
    expect(policyKeyFor([".example.com"])).not.toBe(base); // suffix ≠ exact
    expect(policyKeyFor(["example.com:8443"])).not.toBe(base); // port matters
    expect(policyKeyFor([])).not.toBe(base);
  });

  it("ignores malformed rules, so a typo cannot fork a policy onto its own proxy", () => {
    expect(policyKeyFor(["example.com", "a b c"])).toBe(policyKeyFor(["example.com"]));
  });

  it("gives the empty allowlist a stable key — it is a real policy, not an error", () => {
    expect(policyKeyFor([])).toBe(policyKeyFor(["#just a comment"]));
    expect(policyKeyFor([])).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------------------
// Docker object naming
// ---------------------------------------------------------------------------

describe("network and container naming", () => {
  const key = policyKeyFor(["example.com"]);

  it("produces names Docker accepts", () => {
    const valid = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
    expect(egressNetworkName(key)).toMatch(valid);
    expect(proxyContainerName(key)).toMatch(valid);
    expect(egressNetworkName(POLICY_KEY_NONE)).toMatch(valid);
    expect(egressNetworkName(POLICY_KEY_OPEN)).toMatch(valid);
  });

  it("is deterministic — the same policy finds the same network next boot", () => {
    expect(egressNetworkName(key)).toBe(egressNetworkName(policyKeyFor(["EXAMPLE.com"])));
  });

  it("separates distinct policies", () => {
    expect(egressNetworkName(key)).not.toBe(egressNetworkName(policyKeyFor(["other.com"])));
    expect(egressNetworkName(POLICY_KEY_NONE)).not.toBe(egressNetworkName(POLICY_KEY_OPEN));
  });

  it("never collapses a nonsense key to an empty name", () => {
    expect(egressNetworkName("")).toMatch(/default$/);
    expect(egressNetworkName("///")).toMatch(/default$/);
  });
});

// ---------------------------------------------------------------------------
// The environment an agent gets
// ---------------------------------------------------------------------------

describe("proxyEnvForAgent", () => {
  const env = proxyEnvForAgent({
    agentId: "agent-1",
    agentToken: "tok-abc",
    noProxyHosts: ["app"],
  });
  const asMap = Object.fromEntries(
    env.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]),
  );

  it("sets both cases of every variable", () => {
    // No standard exists: curl and git read lowercase, most Node and Python
    // tooling reads uppercase, and several read whichever they find first.
    for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
      expect(asMap[key]).toBe(`http://agent-1:tok-abc@${PROXY_ALIAS}:${PROXY_PORT}`);
    }
  });

  it("carries per-agent credentials, not a shared one", () => {
    const other = proxyEnvForAgent({ agentId: "agent-2", agentToken: "tok-xyz" });
    expect(other[0]).not.toBe(env[0]);
    expect(other[0]).toContain("agent-2:tok-xyz");
  });

  it("percent-encodes credentials so an odd token cannot break the URL", () => {
    const odd = proxyEnvForAgent({ agentId: "a/b", agentToken: "p@ss:word" });
    expect(odd[0]).toContain("a%2Fb:p%40ss%3Aword@");
    // The credential separator must remain unambiguous.
    expect(new URL(odd[0].split("=")[1]).username).toBe("a%2Fb");
  });

  it("keeps harness traffic off the proxy", () => {
    // The sidecar's events and the skill scripts' channel posts never leave
    // Docker. Routing them through the proxy would put the transcript itself
    // under the allowlist, so an agent with an empty allowlist would go
    // invisible rather than merely offline.
    expect(asMap.NO_PROXY.split(",")).toContain("app");
    expect(asMap.no_proxy).toBe(asMap.NO_PROXY);
  });

  it("always exempts loopback", () => {
    for (const host of ["localhost", "127.0.0.1", "::1"]) {
      expect(asMap.NO_PROXY.split(",")).toContain(host);
    }
  });

  it("does not repeat a host that is already exempt", () => {
    const dup = proxyEnvForAgent({
      agentId: "a",
      agentToken: "t",
      noProxyHosts: ["localhost", "app", "app"],
    });
    const noProxy = dup
      .find((e) => e.startsWith("NO_PROXY="))!
      .slice("NO_PROXY=".length)
      .split(",");
    expect(noProxy).toEqual([...new Set(noProxy)]);
  });
});

// ---------------------------------------------------------------------------
// The enforcement gate — the honest part
// ---------------------------------------------------------------------------

describe("evaluateEnforcement", () => {
  const enforceable = {
    mode: "allowlist" as const,
    egressEnforce: true,
    networkName: "blackhouse",
    blackhouseUrl: "http://app:3000",
  };

  it("enforces when the operator opted in and the topology supports it", () => {
    expect(evaluateEnforcement(enforceable)).toEqual({ enforce: true, reason: null });
  });

  it("enforces `none` the same way — it also needs the internal network", () => {
    expect(evaluateEnforcement({ ...enforceable, mode: "none" }).enforce).toBe(true);
  });

  it("never enforces `open`, which is what that policy means", () => {
    expect(evaluateEnforcement({ ...enforceable, mode: "open" })).toEqual({
      enforce: false,
      reason: "policy-open",
    });
  });

  it("respects the documented dev escape hatch", () => {
    expect(evaluateEnforcement({ ...enforceable, egressEnforce: false })).toEqual({
      enforce: false,
      reason: "disabled",
    });
  });

  it("refuses in host mode rather than guessing about internal-network port publishing", () => {
    // Host mode reaches an agent's IDE and browser tabs through a published
    // 127.0.0.1 port, and ports are only published when no network is named.
    // Whether loopback publishing even works on an `internal: true` network is
    // unverified on a real host — so this refuses instead of pretending.
    for (const networkName of [undefined, null, ""]) {
      expect(evaluateEnforcement({ ...enforceable, networkName })).toEqual({
        enforce: false,
        reason: "host-mode",
      });
    }
  });

  it("refuses a harness URL the agent could not reach from an internal network", () => {
    // `host.docker.internal` is an ExtraHosts alias to the host gateway. An
    // internal network has no gateway, and we drop that alias anyway — so an
    // agent "enforced" with this URL would simply lose the harness.
    for (const blackhouseUrl of [
      "http://host.docker.internal:3000",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "not a url",
    ]) {
      expect(evaluateEnforcement({ ...enforceable, blackhouseUrl })).toEqual({
        enforce: false,
        reason: "unroutable-harness-url",
      });
    }
  });

  it("checks the opt-in before the topology, so the reason names the likeliest cause", () => {
    expect(
      evaluateEnforcement({ ...enforceable, egressEnforce: false, networkName: undefined }).reason,
    ).toBe("disabled");
  });
});

describe("harnessHostname", () => {
  it("extracts the name agents resolve", () => {
    expect(harnessHostname("http://app:3000")).toBe("app");
    expect(harnessHostname("https://blackhouse.internal/base")).toBe("blackhouse.internal");
  });

  it("returns null for something unparseable", () => {
    expect(harnessHostname("app:3000")).toBeNull();
    expect(harnessHostname("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The spec an enforced agent actually gets
// ---------------------------------------------------------------------------

const agent = {
  id: "agent-1",
  handle: "scout",
  agentToken: "tok",
  workspaceVolume: "bh-ws-1",
  stateVolume: "bh-state-1",
  containerImage: "blackhouse-agent:latest",
  egressPolicy: null,
  systemPromptOverride: null,
  gitRepoUrl: null,
  gitBranch: null,
} as unknown as Parameters<typeof buildAgentSpec>[0];

const blueprint = {
  id: "bp-1",
  cli: "claude-code",
  image: "blackhouse-agent:latest",
  egressPolicy: "allowlist",
  envVars: null,
  volumeMounts: null,
  stateMountPath: null,
  agentCommand: null,
  systemPrompt: null,
} as unknown as Parameters<typeof buildAgentSpec>[1];

function attachment(over: Partial<EgressAttachment> = {}): EgressAttachment {
  return {
    mode: "allowlist",
    policyKey: policyKeyFor(["example.com"]),
    rules: ["example.com"],
    enforced: true,
    reason: null,
    networkName: "blackhouse-egress-abc123",
    hostGateway: false,
    env: proxyEnvForAgent({ agentId: "agent-1", agentToken: "tok", noProxyHosts: ["app"] }),
    ...over,
  };
}

describe("buildAgentSpec with an egress attachment", () => {
  it("puts the agent on the policy network instead of the bridge", () => {
    const spec = buildAgentSpec(agent, blueprint, {
      blackhouseUrl: "http://app:3000",
      networkName: "blackhouse",
      egress: attachment(),
    });
    expect(spec.network?.name).toBe("blackhouse-egress-abc123");
  });

  it("never grants host-gateway to a contained agent (landmine 6)", () => {
    const spec = buildAgentSpec(agent, blueprint, {
      blackhouseUrl: "http://app:3000",
      networkName: "blackhouse",
      egress: attachment(),
    });
    expect(spec.network?.hostGateway).toBe(false);
  });

  it("grants host-gateway only under `open`", () => {
    const spec = buildAgentSpec(agent, blueprint, {
      blackhouseUrl: "http://app:3000",
      networkName: "blackhouse",
      egress: attachment({ mode: "open", hostGateway: true, enforced: false, env: [] }),
    });
    expect(spec.network?.hostGateway).toBe(true);
  });

  it("passes the proxy environment through", () => {
    const spec = buildAgentSpec(agent, blueprint, {
      blackhouseUrl: "http://app:3000",
      networkName: "blackhouse",
      egress: attachment(),
    });
    expect(spec.env).toContain(`HTTPS_PROXY=http://agent-1:tok@${PROXY_ALIAS}:${PROXY_PORT}`);
  });

  it("lets the proxy variables win over a blueprint that sets its own", () => {
    // Docker takes the last occurrence of a repeated key, so a blueprint
    // cannot opt its own agent out of the proxy through `envVars`.
    const sneaky = {
      ...blueprint,
      envVars: [{ key: "HTTPS_PROXY", value: "http://attacker:1" }],
    } as unknown as Parameters<typeof buildAgentSpec>[1];

    const spec = buildAgentSpec(agent, sneaky, {
      blackhouseUrl: "http://app:3000",
      networkName: "blackhouse",
      egress: attachment(),
    });
    const proxies = spec.env!.filter((e) => e.startsWith("HTTPS_PROXY="));
    expect(proxies.at(-1)).toContain(PROXY_ALIAS);
  });

  it("falls back to the bridge with no proxy env when enforcement is off", () => {
    const spec = buildAgentSpec(agent, blueprint, {
      blackhouseUrl: "http://app:3000",
      networkName: "blackhouse",
      egress: attachment({ enforced: false, reason: "disabled", networkName: undefined, env: [] }),
    });
    expect(spec.network?.name).toBe("blackhouse");
    expect(spec.env!.some((e) => e.startsWith("HTTPS_PROXY="))).toBe(false);
    // Still no host-gateway: that costs nothing and closes landmine 6 even
    // when the rest of the policy is only advisory.
    expect(spec.network?.hostGateway).toBe(false);
  });

  it("behaves exactly as before when no attachment is supplied", () => {
    const spec = buildAgentSpec(agent, blueprint, {
      blackhouseUrl: "http://app:3000",
      networkName: "blackhouse",
    });
    expect(spec.network).toEqual({ name: "blackhouse", hostGateway: false });
    expect(spec.tty).toBe(true);
    expect(spec.openStdin).toBe(true);
  });
});
