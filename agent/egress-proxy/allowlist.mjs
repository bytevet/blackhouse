/**
 * Egress allowlist matching — in-container mirror of `server/egress/allowlist.ts`.
 *
 * The proxy runs inside a container as a zero-dependency ES module and cannot
 * import TypeScript, so this is a hand-port of that file. The two must stay
 * behaviourally identical: `tests/unit/egress-allowlist.test.ts` imports BOTH
 * and runs one shared case table against each, so drift fails CI rather than
 * silently opening a hole on the side that actually enforces.
 *
 * Read the TypeScript original for the rule grammar, the reasoning behind
 * default ports, and the two classic suffix-matching bugs this guards against.
 * Comments here are kept to the parts a reader of the proxy needs.
 */

// --- Types (documented, not enforced — this file is plain JS) --------------
//
// EgressMode: "none" | "allowlist" | "open"
// DenyReason: "no-rules" | "no-match" | "invalid-host" | "invalid-port" | "mode-none"
// MatchResult: { allowed: boolean, rule: string|null, reason: DenyReason|null }
// ParsedTarget: { host: string, port: number|null, kind: "domain"|"ipv4"|"ipv6" }

/** Ports a bare (portless) rule covers. */
export const DEFAULT_RULE_PORTS = [80, 443];

// Kept in sync with the TS original. The hyphen is deliberately absent — it is
// a legal host character. A colon is present because by this point the port has
// already been split off, so a leftover colon marks a malformed rule.
const UNSAFE_HOST_CHARS = /[/\\?#@:%[\]\s\x00-\x1f\x7f]/;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function normalizeIPv4(input) {
  const m = IPV4_RE.exec(input);
  if (!m) return null;
  const octets = m.slice(1, 5).map((o) => Number(o));
  // Leading zeros are octal to some resolvers and decimal to others. Deny
  // rather than guess which one the target's stack will pick.
  for (let i = 0; i < 4; i++) {
    if (m[i + 1].length > 1 && m[i + 1][0] === "0") return null;
    if (!Number.isInteger(octets[i]) || octets[i] < 0 || octets[i] > 255) return null;
  }
  return octets.join(".");
}

/** Expand an IPv6 literal to its full 8-group zero-padded lowercase form. */
export function normalizeIPv6(input) {
  let s = String(input).toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (s.length === 0) return null;

  // Fold a trailing dotted-quad into two hex groups.
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4) {
    const dotted = normalizeIPv4(v4[1]);
    if (!dotted) return null;
    const p = dotted.split(".").map(Number);
    const hi = ((p[0] << 8) | p[1]).toString(16).padStart(4, "0");
    const lo = ((p[2] << 8) | p[3]).toString(16).padStart(4, "0");
    s = s.slice(0, v4.index) + hi + ":" + lo;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;

  const head = halves[0].length > 0 ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1].length > 0 ? halves[1].split(":") : [];

  let groups;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array(fill).fill("0"), ...tail];
  }

  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(g.padStart(4, "0"));
  }
  return out.join(":");
}

/** Normalize a bare host (no port). `null` means deny. */
export function normalizeHost(raw) {
  if (typeof raw !== "string") return null;
  let h = raw.trim();
  if (h.length === 0) return null;

  if (h.startsWith("[")) {
    if (!h.endsWith("]")) return null;
    const v6 = normalizeIPv6(h.slice(1, -1));
    return v6 ? { host: v6, port: null, kind: "ipv6" } : null;
  }

  // Two or more colons means a bare IPv6 literal; one colon is host:port.
  if (h.indexOf(":") !== h.lastIndexOf(":")) {
    const v6 = normalizeIPv6(h);
    return v6 ? { host: v6, port: null, kind: "ipv6" } : null;
  }

  if (UNSAFE_HOST_CHARS.test(h)) return null;

  while (h.endsWith(".")) h = h.slice(0, -1);
  if (h.length === 0) return null;
  if (h.startsWith(".") || h.includes("..")) return null;

  const v4 = normalizeIPv4(h);
  if (v4) return { host: v4, port: null, kind: "ipv4" };

  let hostname;
  try {
    hostname = new URL("http://" + h).hostname;
  } catch {
    return null;
  }
  if (hostname.length === 0) return null;
  if (hostname.startsWith("[")) return null;
  while (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (hostname.length === 0) return null;
  return { host: hostname, port: null, kind: "domain" };
}

/** Split `host`, `host:port`, `[v6]`, `[v6]:port` and normalize. `null` = deny. */
export function parseTarget(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length === 0) return null;

  let hostPart = s;
  let portPart = null;

  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close === -1) return null;
    hostPart = s.slice(0, close + 1);
    const rest = s.slice(close + 1);
    if (rest.length > 0) {
      if (rest[0] !== ":") return null;
      portPart = rest.slice(1);
    }
  } else {
    const first = s.indexOf(":");
    if (first !== -1 && first === s.lastIndexOf(":")) {
      hostPart = s.slice(0, first);
      portPart = s.slice(first + 1);
    }
  }

  const parsed = normalizeHost(hostPart);
  if (!parsed) return null;

  if (portPart === null) return parsed;
  if (!/^\d{1,5}$/.test(portPart)) return null;
  const port = Number(portPart);
  if (port < 1 || port > 65535) return null;
  return { ...parsed, port };
}

/** Parse one rule string. `null` = malformed; the caller skips it. */
function parseRule(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.length === 0) return null;
  if (s.startsWith("#")) return null;

  if (s === "*") {
    return { raw, suffix: false, any: true, host: "", kind: "any", port: "*" };
  }

  let portPart = null;
  if (s.endsWith(":*")) {
    portPart = "*";
    s = s.slice(0, -2);
  }

  let suffix = false;
  if (s.startsWith("*.")) {
    suffix = true;
    s = s.slice(2);
  } else if (s.startsWith(".")) {
    suffix = true;
    s = s.slice(1);
  }

  if (s.length === 0) return null;

  const target = portPart === "*" ? normalizeHost(s) : parseTarget(s);
  if (!target) return null;

  // No such thing as a subdomain of an address.
  if (suffix && target.kind !== "domain") return null;
  // A one-label suffix rule would allowlist a whole TLD.
  if (suffix && !target.host.includes(".")) return null;

  const port = portPart === "*" ? "*" : (target.port ?? null);
  return { raw, suffix, any: false, host: target.host, kind: target.kind, port };
}

function portAllowed(rule, port) {
  if (rule.port === "*") return true;
  if (rule.port === null) return DEFAULT_RULE_PORTS.includes(port);
  return rule.port === port;
}

/**
 * Decide whether `host` is permitted by `rules`. Fails closed: a missing or
 * empty rule list, an unparseable host, or an out-of-range port all deny.
 */
export function matchHost(host, rules, port) {
  const target = parseTarget(host);
  if (!target) return { allowed: false, rule: null, reason: "invalid-host" };

  let effectivePort;
  if (typeof port === "number") {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { allowed: false, rule: null, reason: "invalid-port" };
    }
    effectivePort = port;
  } else if (target.port !== null) {
    effectivePort = target.port;
  } else {
    effectivePort = 80;
  }

  if (!Array.isArray(rules) || rules.length === 0) {
    return { allowed: false, rule: null, reason: "no-rules" };
  }

  let sawValidRule = false;
  for (const raw of rules) {
    const rule = parseRule(raw);
    if (!rule) continue;
    sawValidRule = true;

    if (rule.any) return { allowed: true, rule: rule.raw, reason: null };
    if (!portAllowed(rule, effectivePort)) continue;

    if (rule.suffix) {
      // Label-boundary suffix: matches a.example.com, never example.com
      // itself and never evil-example.com.
      if (target.kind !== "domain") continue;
      if (target.host.endsWith("." + rule.host)) {
        return { allowed: true, rule: rule.raw, reason: null };
      }
      continue;
    }

    // Exact equality on fully normalized hosts. Never startsWith/includes:
    // that is what lets example.com.attacker.net through.
    if (target.host === rule.host && target.kind === rule.kind) {
      return { allowed: true, rule: rule.raw, reason: null };
    }
  }

  return { allowed: false, rule: null, reason: sawValidRule ? "no-match" : "no-rules" };
}

/** Mode-aware wrapper. An unrecognized mode is treated as the restrictive one. */
export function checkEgress(mode, host, rules, port) {
  if (mode === "none") return { allowed: false, rule: null, reason: "mode-none" };
  if (mode === "open") return { allowed: true, rule: "*", reason: null };
  return matchHost(host, rules, port);
}

/** Normalize + dedupe + sort a rule list into the canonical proxy-sharing form. */
export function canonicalizeRules(rules) {
  if (!Array.isArray(rules)) return [];
  const out = new Set();
  for (const raw of rules) {
    const rule = parseRule(raw);
    if (!rule) continue;
    if (rule.any) {
      out.add("*");
      continue;
    }
    const host = rule.kind === "ipv6" ? `[${rule.host}]` : rule.host;
    const prefix = rule.suffix ? "." : "";
    const port = rule.port === null ? "" : `:${rule.port}`;
    out.add(`${prefix}${host}${port}`);
  }
  return [...out].sort();
}

/** Was this rule written as a bare IP literal? See the TS original. */
export function ruleIsIpLiteral(raw) {
  const rule = parseRule(raw);
  return rule !== null && !rule.any && (rule.kind === "ipv4" || rule.kind === "ipv6");
}

/**
 * Is this a private / loopback / link-local / CGNAT address?
 *
 * Called on `socket.remoteAddress` AFTER the TCP connection is established, so
 * there is no TOCTOU window: we judge the address we actually reached, not one
 * we resolved a moment earlier. Without this an allowlisted domain whose DNS
 * answer points at 169.254.169.254 turns the proxy into a confused deputy.
 */
export function isBlockedAddress(addr) {
  if (typeof addr !== "string" || addr.length === 0) return true;
  let s = addr.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);

  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (mapped) s = mapped[1];

  const v4 = normalizeIPv4(s);
  if (v4) {
    const [a, b] = v4.split(".").map(Number);
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;
    if (a >= 224) return true;
    return false;
  }

  const v6 = normalizeIPv6(s);
  if (v6) {
    if (v6 === "0000:0000:0000:0000:0000:0000:0000:0001") return true;
    if (v6 === "0000:0000:0000:0000:0000:0000:0000:0000") return true;
    const head = parseInt(v6.slice(0, 4), 16);
    if ((head & 0xfe00) === 0xfc00) return true;
    if ((head & 0xffc0) === 0xfe80) return true;
    if ((head & 0xff00) === 0xff00) return true;
    return false;
  }

  // Not an IP literal at all — we were handed something unexpected. Deny.
  return true;
}
