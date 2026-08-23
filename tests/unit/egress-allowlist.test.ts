/**
 * Egress allowlist matching.
 *
 * This is the security-critical function in Phase 6: the one place that decides
 * whether untrusted, model-authored code may reach a host. It exists twice —
 * `server/egress/allowlist.ts` (harness) and `agent/egress-proxy/allowlist.mjs`
 * (the proxy that actually enforces) — because the proxy runs as a
 * zero-dependency ES module in a container and cannot import TypeScript.
 *
 * So the case table below runs against BOTH. Drift between the copy we reason
 * about and the copy that enforces fails here rather than silently opening a
 * hole on the side that matters.
 */

import { describe, it, expect } from "vitest";
import * as ts from "../../server/egress/allowlist.js";

// Loaded through a computed specifier so `tsc` does not try to type a .mjs
// with no declarations. The shape is asserted structurally below.
const mjs = (await import(
  new URL("../../agent/egress-proxy/allowlist.mjs", import.meta.url).href
)) as typeof ts;

const IMPLEMENTATIONS: Array<[string, typeof ts]> = [
  ["server (TypeScript)", ts],
  ["proxy (.mjs mirror)", mjs],
];

/** [host, rules, expected allowed, label] */
type Case = [string, string[], boolean, string];

const RULES_SUFFIX = [".example.com"];
const RULES_EXACT = ["example.com"];

const CASES: Case[] = [
  // --- exact matching -------------------------------------------------------
  ["example.com:443", RULES_EXACT, true, "exact host on 443"],
  ["example.com:80", RULES_EXACT, true, "exact host on 80"],
  ["EXAMPLE.COM:443", RULES_EXACT, true, "host case is folded"],
  ["example.com.:443", RULES_EXACT, true, "FQDN root dot is stripped"],
  ["example.com:443", ["EXAMPLE.COM"], true, "rule case is folded"],
  ["example.com:443", ["  example.com  "], true, "rule whitespace is trimmed"],
  ["other.com:443", RULES_EXACT, false, "unrelated host"],

  // --- the two classic bugs -------------------------------------------------
  [
    "example.com.attacker.net:443",
    RULES_EXACT,
    false,
    "a rule must not match as a PREFIX of a longer host",
  ],
  [
    "evil-example.com:443",
    RULES_SUFFIX,
    false,
    "a suffix rule must not match without a label boundary",
  ],
  ["notexample.com:443", RULES_SUFFIX, false, "suffix rule, no boundary, no dash"],
  ["example.com.evil.com:443", RULES_SUFFIX, false, "suffix rule text appearing mid-host"],
  ["xexample.com:443", RULES_EXACT, false, "one character prepended"],
  ["example.como:443", RULES_EXACT, false, "one character appended"],

  // --- suffix semantics -----------------------------------------------------
  ["api.example.com:443", RULES_SUFFIX, true, "direct subdomain"],
  ["a.b.c.example.com:443", RULES_SUFFIX, true, "deep subdomain"],
  ["api-staging.example.com:443", RULES_SUFFIX, true, "hyphens are legal in a host"],
  ["example.com:443", RULES_SUFFIX, false, "a suffix rule does NOT grant the apex"],
  ["api.example.com:443", ["*.example.com"], true, "star-dot is an alias for dot"],
  ["example.com:443", ["*.example.com"], false, "star-dot does not grant the apex either"],
  ["anything.com:443", [".com"], false, "a single-label suffix rule (whole TLD) is rejected"],
  ["a.b.co.uk:443", [".co.uk"], true, "two-label suffix rules are allowed as written"],

  // --- ports ----------------------------------------------------------------
  ["example.com:8443", RULES_EXACT, false, "a bare rule covers 80/443 only"],
  ["example.com:8443", ["example.com:8443"], true, "explicit port"],
  ["example.com:443", ["example.com:8443"], false, "explicit port excludes the defaults"],
  ["example.com:9999", ["example.com:*"], true, "port wildcard"],
  ["api.example.com:8080", [".example.com:*"], true, "port wildcard on a suffix rule"],
  ["api.example.com:8080", [".example.com"], false, "suffix rule still defaults to 80/443"],
  ["example.com:0", RULES_EXACT, false, "port 0 is not a port"],
  ["example.com:99999", RULES_EXACT, false, "port above 65535"],
  ["example.com:https", RULES_EXACT, false, "a named port is not a number"],

  // --- malformed rules must be dropped, never widened -----------------------
  [
    "example.com:443",
    ["example.com:8080:*"],
    false,
    "a double-port rule is malformed and must not widen to any-port",
  ],
  ["example.com:443", ["", "   ", "#comment"], false, "blank and comment-only rules grant nothing"],
  ["example.com:443", ["!!!", "http://example.com", "a b c"], false, "garbage rules grant nothing"],
  ["example.com:443", ["#example.com"], false, "a commented-out rule is not a rule"],
  ["example.com:443", [".1.2.3.4"], false, "a suffix rule over an IP is meaningless"],

  // --- URL-parser confusion -------------------------------------------------
  ["evil.com@example.com:443", RULES_EXACT, false, "userinfo must not re-point the host"],
  ["example.com@evil.com:443", RULES_EXACT, false, "userinfo the other way round"],
  ["example.com/../evil.com:443", RULES_EXACT, false, "a path separator is not a host"],
  ["example.com#evil:443", RULES_EXACT, false, "a fragment is not a host"],
  ["example.com?a=b:443", RULES_EXACT, false, "a query is not a host"],
  ["example.com%2eattacker.net:443", RULES_EXACT, false, "percent-encoding is not decoded"],
  ["example.com\\evil.com:443", RULES_EXACT, false, "a backslash is not a host separator"],
  [".example.com:443", RULES_EXACT, false, "a leading dot in a HOST is malformed"],
  ["example..com:443", RULES_EXACT, false, "an empty label is malformed"],

  // --- IDN / punycode -------------------------------------------------------
  ["münchen.de:443", ["xn--mnchen-3ya.de"], true, "unicode host against a punycode rule"],
  ["xn--mnchen-3ya.de:443", ["münchen.de"], true, "punycode host against a unicode rule"],
  ["münchen.de:443", ["münchen.de"], true, "unicode on both sides"],
  ["api.münchen.de:443", [".xn--mnchen-3ya.de"], true, "IDN suffix rule"],
  ["evil-münchen.de:443", [".xn--mnchen-3ya.de"], false, "IDN suffix rule, no label boundary"],

  // --- IP literals ----------------------------------------------------------
  ["192.0.2.10:443", ["192.0.2.10"], true, "IPv4 literal"],
  ["192.0.2.11:443", ["192.0.2.10"], false, "a different IPv4"],
  ["010.0.2.10:443", ["10.0.2.10"], false, "a leading-zero octet is ambiguous, so denied"],
  ["192.0.2.999:443", ["192.0.2.999"], false, "an out-of-range octet is not an address"],
  ["[2001:db8::1]:443", ["[2001:db8::1]"], true, "IPv6 literal"],
  ["[2001:db8::1]:443", ["2001:db8::1"], true, "IPv6 rule without brackets"],
  [
    "[2001:0db8:0000:0000:0000:0000:0000:0001]:443",
    ["2001:db8::1"],
    true,
    "compressed and expanded IPv6 are one address",
  ],
  ["[2001:db8::2]:443", ["2001:db8::1"], false, "a different IPv6"],
  ["[::ffff:192.0.2.10]:443", ["::ffff:192.0.2.10"], true, "IPv4-mapped IPv6"],

  // --- catch-all ------------------------------------------------------------
  ["anything.at.all:1234", ["*"], true, "the catch-all rule allows everything"],
  ["192.0.2.1:1234", ["*"], true, "the catch-all covers IPs and odd ports too"],
];

describe.each(IMPLEMENTATIONS)("matchHost — %s", (_label, impl) => {
  it.each(CASES)("%s against %j is %s (%s)", (host, rules, expected) => {
    expect(impl.matchHost(host, rules).allowed).toBe(expected);
  });

  describe("fails closed", () => {
    it("denies when the rule list is empty", () => {
      expect(impl.matchHost("example.com:443", [])).toMatchObject({
        allowed: false,
        reason: "no-rules",
      });
    });

    it("denies when the rule list is absent", () => {
      expect(impl.matchHost("example.com:443", null).allowed).toBe(false);
      expect(impl.matchHost("example.com:443", undefined).allowed).toBe(false);
    });

    it("denies when every rule is malformed, and says so", () => {
      // "no-rules" rather than "no-match": nothing valid was ever parsed, so
      // the operator's allowlist is broken, not merely narrow.
      expect(impl.matchHost("example.com:443", ["///", "#x"])).toMatchObject({
        allowed: false,
        reason: "no-rules",
      });
    });

    it("reports no-match when valid rules simply did not cover the host", () => {
      expect(impl.matchHost("other.com:443", RULES_EXACT)).toMatchObject({
        allowed: false,
        reason: "no-match",
      });
    });

    it("denies an unparseable host", () => {
      expect(impl.matchHost("", ["*"])).toMatchObject({ allowed: false, reason: "invalid-host" });
      expect(impl.matchHost("   ", ["*"]).allowed).toBe(false);
    });

    it("denies an out-of-range explicit port argument", () => {
      expect(impl.matchHost("example.com", RULES_EXACT, 0)).toMatchObject({
        allowed: false,
        reason: "invalid-port",
      });
      expect(impl.matchHost("example.com", RULES_EXACT, 70000).allowed).toBe(false);
      expect(impl.matchHost("example.com", RULES_EXACT, 1.5).allowed).toBe(false);
    });

    it("survives non-string entries in the rule list", () => {
      const rules = [null, 42, {}, ["example.com"], "example.com"] as unknown as string[];
      expect(impl.matchHost("example.com:443", rules).allowed).toBe(true);
      expect(impl.matchHost("other.com:443", rules).allowed).toBe(false);
    });

    it("survives a non-string host", () => {
      expect(impl.matchHost(null as unknown as string, ["*"]).allowed).toBe(false);
      expect(impl.matchHost(42 as unknown as string, ["*"]).allowed).toBe(false);
    });
  });

  describe("port argument", () => {
    it("wins over a port embedded in the host", () => {
      expect(impl.matchHost("example.com:443", ["example.com:8443"], 8443).allowed).toBe(true);
      expect(impl.matchHost("example.com:8443", RULES_EXACT, 443).allowed).toBe(true);
    });

    it("defaults a portless host to 80, the plain-HTTP case", () => {
      expect(impl.matchHost("example.com", RULES_EXACT).allowed).toBe(true);
      expect(impl.matchHost("example.com", ["example.com:8443"]).allowed).toBe(false);
    });
  });

  describe("the granting rule is reported verbatim, for the audit log", () => {
    it("returns the rule as the operator wrote it", () => {
      expect(impl.matchHost("api.example.com:443", ["  *.EXAMPLE.com  "]).rule).toBe(
        "  *.EXAMPLE.com  ",
      );
    });

    it("returns null when denied", () => {
      expect(impl.matchHost("other.com:443", RULES_EXACT).rule).toBeNull();
    });
  });

  describe("checkEgress mode wrapper", () => {
    it("denies everything under `none`, even a matching rule", () => {
      expect(impl.checkEgress("none", "example.com:443", ["*"])).toMatchObject({
        allowed: false,
        reason: "mode-none",
      });
    });

    it("allows everything under `open`", () => {
      expect(impl.checkEgress("open", "anything:9999", []).allowed).toBe(true);
    });

    it("defers to the allowlist under `allowlist`", () => {
      expect(impl.checkEgress("allowlist", "example.com:443", RULES_EXACT).allowed).toBe(true);
      expect(impl.checkEgress("allowlist", "other.com:443", RULES_EXACT).allowed).toBe(false);
    });

    it("treats an unknown mode as the restrictive branch", () => {
      // A future enum value reaching an old proxy must never mean "open".
      expect(impl.checkEgress("supervised", "other.com:443", RULES_EXACT).allowed).toBe(false);
      expect(impl.checkEgress("", "other.com:443", RULES_EXACT).allowed).toBe(false);
    });
  });

  describe("canonicalizeRules", () => {
    it("is invariant to order, case, duplicates and spelling", () => {
      const a = impl.canonicalizeRules(["B.com", "a.com", "a.com", "A.COM"]);
      const b = impl.canonicalizeRules(["a.com", "b.com"]);
      expect(a).toEqual(b);
    });

    it("folds IDN spellings together", () => {
      expect(impl.canonicalizeRules(["münchen.de"])).toEqual(
        impl.canonicalizeRules(["xn--mnchen-3ya.de"]),
      );
    });

    it("normalizes the wildcard prefix to one form", () => {
      expect(impl.canonicalizeRules(["*.example.com"])).toEqual([".example.com"]);
    });

    it("drops malformed rules so they cannot influence the policy key", () => {
      expect(impl.canonicalizeRules(["ok.com", "a b", "///", "", "#c"])).toEqual(["ok.com"]);
    });

    it("keeps a host that is odd but syntactically legal", () => {
      // `!` is not a forbidden host code point, so WHATWG parses `!!!` as a
      // host. It is not a name DNS can ever resolve and it matches only
      // itself, so the matcher stays a pure comparator and lets it through —
      // rejecting implausible-but-legal hosts is the API layer's job, where a
      // human can be told why (`normalizeRuleHost` in `server/api/egress.ts`).
      expect(impl.canonicalizeRules(["!!!"])).toEqual(["!!!"]);
      expect(impl.matchHost("other.com:443", ["!!!"]).allowed).toBe(false);
    });

    it("returns an empty list for a non-list", () => {
      expect(impl.canonicalizeRules(null)).toEqual([]);
      expect(impl.canonicalizeRules(undefined)).toEqual([]);
    });
  });

  describe("isBlockedAddress — the SSRF / DNS-rebinding guard", () => {
    it.each([
      ["169.254.169.254", "cloud metadata"],
      ["127.0.0.1", "loopback"],
      ["10.1.2.3", "RFC1918 /8"],
      ["172.16.0.1", "RFC1918 /12 lower bound"],
      ["172.31.255.255", "RFC1918 /12 upper bound"],
      ["192.168.1.1", "RFC1918 /16"],
      ["100.64.0.1", "CGNAT"],
      ["0.0.0.0", "this network"],
      ["224.0.0.1", "multicast"],
      ["::1", "IPv6 loopback"],
      ["fd00::1", "IPv6 unique-local"],
      ["fe80::1", "IPv6 link-local"],
      ["::ffff:169.254.169.254", "metadata via an IPv4-mapped IPv6"],
      ["not-an-ip", "a hostname, which we should never be handed"],
      ["", "empty"],
    ])("blocks %s (%s)", (addr) => {
      expect(impl.isBlockedAddress(addr)).toBe(true);
    });

    it.each([["93.184.216.34"], ["8.8.8.8"], ["172.32.0.1"], ["2606:2800:220:1::1"]])(
      "permits the public address %s",
      (addr) => {
        expect(impl.isBlockedAddress(addr)).toBe(false);
      },
    );

    it("ignores a zone suffix when judging a link-local address", () => {
      expect(impl.isBlockedAddress("fe80::1%eth0")).toBe(true);
    });
  });

  describe("ruleIsIpLiteral — the guard's documented exception", () => {
    it("is true for IP rules, which an operator wrote deliberately", () => {
      expect(impl.ruleIsIpLiteral("10.0.5.20")).toBe(true);
      expect(impl.ruleIsIpLiteral("[2001:db8::1]:5000")).toBe(true);
    });

    it("is false for domain rules, so rebinding stays blocked", () => {
      expect(impl.ruleIsIpLiteral("example.com")).toBe(false);
      expect(impl.ruleIsIpLiteral(".example.com")).toBe(false);
      expect(impl.ruleIsIpLiteral("*")).toBe(false);
      expect(impl.ruleIsIpLiteral("")).toBe(false);
    });
  });
});

describe("the two implementations agree", () => {
  it("returns identical results for every case in the table", () => {
    for (const [host, rules] of CASES) {
      expect({ host, ...mjs.matchHost(host, rules) }).toEqual({
        host,
        ...ts.matchHost(host, rules),
      });
    }
  });

  it("canonicalizes identically, so both derive the same policy key", () => {
    const messy = ["B.com", "*.a.com", "münchen.de", "1.2.3.4:8080", "!!!", "*"];
    expect(mjs.canonicalizeRules(messy)).toEqual(ts.canonicalizeRules(messy));
  });
});
