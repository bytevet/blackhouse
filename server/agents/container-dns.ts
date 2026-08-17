import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Name resolution for agent containers.
 *
 * Docker's embedded DNS (127.0.0.11) is how a container normally finds its
 * peers by service name — and it does not work under gVisor. The resolver is a
 * loopback listener in the container's *host-side* network namespace; runsc
 * runs the sandbox on its own netstack (`--network=sandbox`) and never reaches
 * it. Measured on a live host, two containers on one user-defined network
 * differing only in runtime:
 *
 *   [runc ] getent app → 172.18.0.4 ; getent example.com → 2606:4700:10::…
 *   [runsc] getent app → NO-RESOLVE ; getent example.com → NO-RESOLVE
 *   [runsc] UDP query to 127.0.0.11:53 → no reply
 *
 * So an agent under the runtime we *default to on Linux* had no DNS at all:
 * the sidecar could not POST to `http://app:3000`, and `git clone` and
 * `npm install` fail the same way.
 *
 * **What this module fixes:** the names an agent must reach — the harness, and
 * the egress proxy — are pinned into `/etc/hosts`, which needs no resolver.
 * That restores service discovery under both runtimes, and it is what makes
 * the mention -> TUI -> sidecar -> transcript path work under gVisor.
 *
 * **What it does not fix, measured:** general hostname resolution. Setting
 * `HostConfig.Dns` does *not* write those servers into resolv.conf when the
 * container is on a user-defined network — Docker keeps 127.0.0.11 as the stub
 * and uses them only as its own upstreams, which is visible in the generated
 * file as `ExtServers: [1.1.1.1 8.8.8.8]`. Since the stub is exactly what the
 * sandbox cannot reach, the setting is inert there. It is kept because it is
 * still the correct field for the host-network path, and because losing it
 * would make the eventual fix harder to find — not because it currently helps
 * a gVisor agent.
 *
 * The sandbox itself is not the obstacle: from inside runsc, a UDP query
 * straight to `1.1.1.1:53` gets a reply and `https://1.1.1.1` returns 301. The
 * obstacle is purely that resolv.conf points at a loopback stub. Getting a
 * real nameserver into that file on a user-defined network means either
 * writing it from the entrypoint (which runs unprivileged) or leaving the
 * network as the container's secondary — and that second option reintroduces
 * the default bridge, which is the route out that egress enforcement exists to
 * remove. That trade-off is a design decision, not a bug fix, so it is
 * documented in the plan rather than made here.
 */

/** Runtimes whose sandbox can reach Docker's embedded resolver at 127.0.0.11. */
export function hasEmbeddedDns(runtime: string | null | undefined): boolean {
  return runtime !== "runsc";
}

const DEFAULT_AGENT_DNS = ["1.1.1.1", "8.8.8.8"];

/**
 * Nameservers handed to a container that cannot use the embedded one.
 *
 * Public resolvers by default because there is no reliable alternative to
 * inherit: the host's own `/etc/resolv.conf` commonly points at a
 * systemd-resolved stub on 127.0.0.53, which is loopback from the container's
 * point of view and no more reachable than 127.0.0.11. Operators who want
 * their own resolver set `BLACKHOUSE_AGENT_DNS`; an empty string opts out.
 *
 * See the module comment for the measured caveat: on a user-defined network
 * Docker treats these as upstreams for its own stub rather than writing them
 * into resolv.conf, so today they do not restore resolution inside gVisor.
 */
export function agentDnsServers(): string[] {
  const raw = process.env.BLACKHOUSE_AGENT_DNS;
  if (raw === undefined) return DEFAULT_AGENT_DNS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isIP(s) !== 0);
}

/**
 * Resolve a URL's hostname to an `/etc/hosts` entry.
 *
 * Returns null when there is nothing useful to pin: an IP literal already
 * needs no resolution, `host.docker.internal` is supplied by Docker itself via
 * `host-gateway`, and a name that does not resolve *here* would only produce a
 * wrong entry. A null result is not an error — the caller simply pins nothing,
 * and under runc the embedded resolver still handles it.
 */
export async function resolveHostAlias(
  url: string,
  resolver: (host: string) => Promise<string> = async (h) => (await lookup(h)).address,
): Promise<{ host: string; ip: string } | null> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host || isIP(host) !== 0 || host === "host.docker.internal") return null;

  try {
    const ip = await resolver(host);
    return isIP(ip) === 0 ? null : { host, ip };
  } catch {
    return null;
  }
}

/**
 * Merge alias lists, keeping the first entry for a given host.
 *
 * Order carries intent: the caller lists the most specific source first (the
 * egress proxy, which is per-policy) ahead of the general one (the harness),
 * so a collision resolves toward the narrower scope rather than by accident.
 */
export function mergeHostAliases(
  ...lists: Array<Array<{ host: string; ip: string } | null | undefined> | null | undefined>
): Array<{ host: string; ip: string }> {
  const seen = new Map<string, { host: string; ip: string }>();
  for (const list of lists) {
    for (const entry of list ?? []) {
      if (entry && !seen.has(entry.host)) seen.set(entry.host, entry);
    }
  }
  return [...seen.values()];
}
