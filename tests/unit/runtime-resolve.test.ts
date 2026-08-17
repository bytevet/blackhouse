import { describe, it, expect } from "vitest";
import {
  parseRuntimeAvailability,
  resolveDriver,
  hasRunsc,
  hasKata,
} from "../../server/sandbox/registry.js";

/**
 * Driver selection decides whether an agent gets a syscall boundary or not, so
 * it is pure and tested against fixture `docker info` payloads. No daemon has
 * gVisor in CI, and the interesting cases are the ones this host cannot show.
 */
const info = (runtimes: string[], def = "runc") => ({
  Runtimes: Object.fromEntries(runtimes.map((r) => [r, { path: `/usr/bin/${r}` }])),
  DefaultRuntime: def,
});

const GVISOR_HOST = parseRuntimeAvailability(info(["io.containerd.runc.v2", "runc", "runsc"]));
const PLAIN_HOST = parseRuntimeAvailability(info(["io.containerd.runc.v2", "runc"]));
const KATA_HOST = parseRuntimeAvailability(info(["runc", "io.containerd.kata.v2"]));

describe("runtime detection", () => {
  it("reads the runtimes map and default", () => {
    expect(GVISOR_HOST.runtimes).toContain("runsc");
    expect(GVISOR_HOST.defaultRuntime).toBe("runc");
  });

  it("detects gVisor, including operator-suffixed variants", () => {
    expect(hasRunsc(GVISOR_HOST)).toBe(true);
    expect(hasRunsc(PLAIN_HOST)).toBe(false);
    expect(hasRunsc(parseRuntimeAvailability(info(["runc", "runsc-kvm"])))).toBe(true);
  });

  it("detects Kata under its containerd shim name", () => {
    expect(hasKata(KATA_HOST)).toBe(true);
    expect(hasKata(GVISOR_HOST)).toBe(false);
  });

  it("survives a daemon that reports no runtimes at all", () => {
    const empty = parseRuntimeAvailability({} as never);
    expect(hasRunsc(empty)).toBe(false);
    expect(resolveDriver("auto", empty).effective).toBe("runc");
  });
});

describe("resolveDriver", () => {
  it("auto prefers gVisor where it exists", () => {
    const r = resolveDriver("auto", GVISOR_HOST);
    expect(r.effective).toBe("runsc");
    expect(r.fellBackFrom).toBeUndefined();
  });

  it("auto falls back to runc on a host without gVisor — silently is not acceptable", () => {
    const r = resolveDriver("auto", PLAIN_HOST);
    expect(r.effective).toBe("runc");
    // macOS and Podman have no runsc, so this is the common case. The reason
    // must be reportable, because an invisible fallback leaves someone
    // believing they have isolation they do not have.
    expect(r.reason).toBeTruthy();
  });

  it("reports the fallback when an explicit request cannot be honoured", () => {
    const r = resolveDriver("runsc", PLAIN_HOST);
    expect(r.effective).toBe("runc");
    expect(r.fellBackFrom).toBe("runsc");
    expect(r.reason).toBeTruthy();
  });

  it("honours an explicit runc request even where gVisor exists", () => {
    const r = resolveDriver("runc", GVISOR_HOST);
    expect(r.effective).toBe("runc");
    expect(r.fellBackFrom).toBeUndefined();
  });

  it("falls back from Kata to the best available boundary", () => {
    const r = resolveDriver("kata", GVISOR_HOST);
    expect(r.effective).toBe("runsc");
    expect(r.fellBackFrom).toBe("kata");
  });

  it("never silently upgrades a weaker request", () => {
    // Asking for runc must not hand back gVisor: the request may exist because
    // a workload is known to break under it.
    expect(resolveDriver("runc", KATA_HOST).effective).toBe("runc");
  });
});
