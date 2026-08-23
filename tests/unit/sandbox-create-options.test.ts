import { describe, it, expect } from "vitest";
import { toCreateOptions } from "../../server/sandbox/docker-base.js";
import { runcDefaults } from "../../server/sandbox/runc.js";
import { runscDefaults } from "../../server/sandbox/runsc.js";
import type { SandboxSpec } from "../../server/sandbox/types.js";

/**
 * `toCreateOptions` is pure precisely so it can be tested without a daemon —
 * no Docker exists in CI or the dev container. These assertions are the only
 * automated check that the isolation flags we believe we set are the flags
 * actually sent to the Docker API.
 */

const base: SandboxSpec = { image: "blackhouse/agent:test" };
const opts = (spec: Partial<SandboxSpec>, defaults: Record<string, unknown> = {}) =>
  toCreateOptions({ ...base, ...spec } as SandboxSpec, defaults as never) as Record<string, any>;

describe("toCreateOptions — runtime selection", () => {
  it("omits Runtime for runc so the daemon default applies", () => {
    // Emitting `Runtime: undefined` is not the same as omitting the key; some
    // API versions reject the explicit null.
    const o = opts({}, runcDefaults(base) as never);
    expect(o.HostConfig.Runtime).toBeUndefined();
    expect(Object.keys(o.HostConfig)).not.toContain("Runtime");
  });

  it("sets Runtime=runsc for gVisor — the entire driver delta", () => {
    expect(opts({}, runscDefaults(base) as never).HostConfig.Runtime).toBe("runsc");
  });
});

describe("toCreateOptions — hardening", () => {
  it("drops all capabilities and adds back only what package managers need", () => {
    const hc = opts({}, runcDefaults(base) as never).HostConfig;
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.CapAdd).toContain("CHOWN");
    expect(hc.CapAdd).toContain("SETUID");
    // KILL is needed to signal child processes; without it an agent cannot
    // stop its own subprocesses.
    expect(hc.CapAdd).toContain("KILL");
    expect(hc.CapAdd).not.toContain("SYS_ADMIN");
  });

  it("sets no-new-privileges and a pids cap", () => {
    const hc = opts({}, runcDefaults(base) as never).HostConfig;
    expect(hc.SecurityOpt).toContain("no-new-privileges:true");
    expect(hc.PidsLimit).toBeGreaterThan(0);
  });

  it("leaves the rootfs writable", () => {
    // Agents run npm/pip constantly. A read-only rootfs is "hardening" that
    // stops everything from starting, which is not hardening.
    expect(opts({}, runcDefaults(base) as never).HostConfig.ReadonlyRootfs).toBeFalsy();
  });

  it("hardens even when the driver supplies nothing", () => {
    // A spec reaching this function with empty defaults must still be capped,
    // not fall through to Docker's permissive defaults.
    const hc = opts({}, {}).HostConfig;
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.PidsLimit).toBeGreaterThan(0);
  });

  it("gVisor does not stack a custom seccomp profile on top of itself", () => {
    // runsc IS the syscall filter; a restrictive seccomp profile over it
    // produces opaque ENOSYS failures.
    const so: string[] = opts({}, runscDefaults(base) as never).HostConfig.SecurityOpt ?? [];
    expect(so.some((s) => s.startsWith("seccomp="))).toBe(false);
  });
});

describe("toCreateOptions — networking", () => {
  it("makes a named network the PRIMARY network, not just an attachment", () => {
    // Regression: found against a live daemon. EndpointsConfig alone connects
    // the container but leaves NetworkMode at `bridge`, and Docker only points
    // /etc/resolv.conf at its embedded resolver (127.0.0.11) when the primary
    // network is user-defined. The agent then holds a correct IP on the correct
    // network and still cannot resolve `app` — which breaks the sidecar, since
    // it reaches the harness by service name.
    const o = opts({ network: { name: "blackhouse" } });
    expect(o.NetworkingConfig.EndpointsConfig).toHaveProperty("blackhouse");
    expect(o.HostConfig.NetworkMode).toBe("blackhouse");
  });

  it("publishes no host ports in container-network mode", () => {
    const o = opts({ network: { name: "blackhouse" }, exposedPorts: [8443] });
    expect(o.HostConfig.PortBindings).toBeUndefined();
  });

  it("publishes to loopback only in host mode", () => {
    const o = opts({ exposedPorts: [8443] });
    expect(o.HostConfig.NetworkMode).toBeUndefined();
    expect(o.HostConfig.PortBindings["8443/tcp"][0].HostIp).toBe("127.0.0.1");
  });

  it("grants host-gateway only when egress is open", () => {
    // host.docker.internal is a direct route to the host and defeats egress
    // control, so it is withheld unless the policy is `open`.
    expect(opts({ network: { hostGateway: false } }).HostConfig.ExtraHosts).toBeUndefined();
    expect(opts({ network: { hostGateway: true } }).HostConfig.ExtraHosts).toContain(
      "host.docker.internal:host-gateway",
    );
  });
});

describe("toCreateOptions — the injection prerequisites", () => {
  it("allocates a TTY and keeps stdin open", () => {
    // This pair is what gives the PTY hub a writable stdin. Without it, the
    // product's central feature silently stops working.
    const o = opts({ tty: true, openStdin: true });
    expect(o.Tty).toBe(true);
    expect(o.OpenStdin).toBe(true);
  });
});

describe("toCreateOptions — passthrough", () => {
  it("carries image, env, labels and mounts", () => {
    const o = opts({
      env: ["A=1"],
      labels: { "blackhouse.managed": "true" },
      mounts: [{ source: "vol", target: "/workspace" }],
    });
    expect(o.Image).toBe("blackhouse/agent:test");
    expect(o.Env).toContain("A=1");
    expect(o.Labels["blackhouse.managed"]).toBe("true");
    expect(o.HostConfig.Binds).toContain("vol:/workspace");
  });

  it("marks a read-only mount", () => {
    const o = opts({ mounts: [{ source: "vol", target: "/ro", readOnly: true }] });
    expect(o.HostConfig.Binds[0]).toMatch(/:ro$/);
  });
});
