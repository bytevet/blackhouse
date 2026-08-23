import { describe, it, expect, afterEach } from "vitest";
import {
  agentDnsServers,
  hasEmbeddedDns,
  mergeHostAliases,
  resolveHostAlias,
} from "../../server/agents/container-dns.js";
import { toCreateOptions } from "../../server/sandbox/docker-base.js";
import type { SandboxSpec } from "../../server/sandbox/types.js";

/**
 * Regression cover for a failure found only on a real gVisor host: Docker's
 * embedded resolver (127.0.0.11) is unreachable from a runsc sandbox, so an
 * agent under the runtime we default to on Linux had no DNS at all — the
 * sidecar could not reach `http://app:3000` and never posted a transcript.
 *
 * The fix is name pinning plus explicit upstream nameservers. These assertions
 * are what stops either half from being quietly dropped again.
 */

const original = process.env.BLACKHOUSE_AGENT_DNS;
afterEach(() => {
  if (original === undefined) delete process.env.BLACKHOUSE_AGENT_DNS;
  else process.env.BLACKHOUSE_AGENT_DNS = original;
});

describe("hasEmbeddedDns", () => {
  it("reports the embedded resolver unusable under gVisor", () => {
    expect(hasEmbeddedDns("runsc")).toBe(false);
  });

  it("reports it usable under runc and for an unknown runtime", () => {
    // Unknown runtimes default to "usable" so we do not strip container-name
    // resolution from a runtime that never had the problem.
    expect(hasEmbeddedDns("runc")).toBe(true);
    expect(hasEmbeddedDns(undefined)).toBe(true);
    expect(hasEmbeddedDns("kata")).toBe(true);
  });
});

describe("agentDnsServers", () => {
  it("defaults to public resolvers", () => {
    delete process.env.BLACKHOUSE_AGENT_DNS;
    expect(agentDnsServers()).toEqual(["1.1.1.1", "8.8.8.8"]);
  });

  it("honours an operator override", () => {
    process.env.BLACKHOUSE_AGENT_DNS = "10.0.0.53, 10.0.0.54";
    expect(agentDnsServers()).toEqual(["10.0.0.53", "10.0.0.54"]);
  });

  it("lets an empty override opt out entirely", () => {
    process.env.BLACKHOUSE_AGENT_DNS = "";
    expect(agentDnsServers()).toEqual([]);
  });

  it("drops entries that are not IPs", () => {
    // Docker's Dns field takes addresses, not names — a name here would be
    // written into resolv.conf and silently resolve nothing.
    process.env.BLACKHOUSE_AGENT_DNS = "resolver.internal,10.0.0.53";
    expect(agentDnsServers()).toEqual(["10.0.0.53"]);
  });
});

describe("resolveHostAlias", () => {
  const fixed = async () => "172.18.0.4";

  it("pins a service name to its address", async () => {
    expect(await resolveHostAlias("http://app:3000", fixed)).toEqual({
      host: "app",
      ip: "172.18.0.4",
    });
  });

  it("pins nothing for a URL that is already an IP", async () => {
    expect(await resolveHostAlias("http://172.18.0.4:3000", fixed)).toBeNull();
  });

  it("pins nothing for host.docker.internal", async () => {
    // Docker supplies that one itself via the host-gateway alias; a second
    // entry would fight it.
    expect(await resolveHostAlias("http://host.docker.internal:3000", fixed)).toBeNull();
  });

  it("returns null rather than throwing when the name does not resolve", async () => {
    const failing = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await resolveHostAlias("http://app:3000", failing)).toBeNull();
  });

  it("returns null for a malformed URL", async () => {
    expect(await resolveHostAlias("not a url", fixed)).toBeNull();
  });
});

describe("mergeHostAliases", () => {
  it("keeps the first entry for a host and drops empties", () => {
    // First-wins is the contract the caller relies on: the proxy (per-policy)
    // is listed ahead of the harness, so the narrower scope wins a collision.
    expect(
      mergeHostAliases(
        [{ host: "proxy", ip: "10.0.0.2" }, null],
        [
          { host: "proxy", ip: "10.0.0.99" },
          { host: "app", ip: "172.18.0.4" },
        ],
        undefined,
      ),
    ).toEqual([
      { host: "proxy", ip: "10.0.0.2" },
      { host: "app", ip: "172.18.0.4" },
    ]);
  });
});

describe("toCreateOptions — name pinning", () => {
  const base: SandboxSpec = { image: "blackhouse/agent:test" };
  const opts = (network: SandboxSpec["network"]) =>
    toCreateOptions({ ...base, network }) as unknown as Record<string, any>;

  it("writes aliases into ExtraHosts alongside the host-gateway entry", () => {
    const hc = opts({
      hostAliases: [{ host: "app", ip: "172.18.0.4" }],
      hostGateway: true,
    }).HostConfig;
    expect(hc.ExtraHosts).toContain("app:172.18.0.4");
    expect(hc.ExtraHosts).toContain("host.docker.internal:host-gateway");
  });

  it("writes aliases even when host-gateway is withheld", () => {
    // The egress phase drops host-gateway for every non-`open` agent. The
    // pinned names must survive that, or an enforced agent loses the harness.
    const hc = opts({
      hostAliases: [{ host: "app", ip: "172.18.0.4" }],
      hostGateway: false,
    }).HostConfig;
    expect(hc.ExtraHosts).toEqual(["app:172.18.0.4"]);
  });

  it("leaves ExtraHosts unset when there is nothing to pin", () => {
    expect(opts({ hostGateway: false }).HostConfig.ExtraHosts).toBeUndefined();
  });

  it("sets Dns only when nameservers are supplied", () => {
    expect(opts({}).HostConfig.Dns).toBeUndefined();
    expect(opts({ dns: [] }).HostConfig.Dns).toBeUndefined();
    expect(opts({ dns: ["1.1.1.1"] }).HostConfig.Dns).toEqual(["1.1.1.1"]);
  });
});
