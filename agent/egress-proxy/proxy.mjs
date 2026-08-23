/**
 * Blackhouse egress proxy.
 *
 * The single container with a route off the internal agent network. Agents sit
 * on a Docker network created with `Internal: true`, so they have no gateway at
 * all — every packet that leaves has to come through here. That topology is the
 * enforcement; the allowlist below is only the policy it applies.
 *
 * Zero dependencies, raw `node:http` + `node:net`, in the same house style as
 * `agent/browser-service/service.mjs`.
 *
 *   CONNECT host:port          tunnel — allowlist check, then a bidirectional pipe
 *   GET http://host/path       absolute-URI plain HTTP — same check, then relayed
 *   GET /healthz               liveness + policy status (no secrets)
 *
 * ## Authentication
 *
 * Per connection, via `Proxy-Authorization: Basic <agent_id>:<agent_token>`.
 * Deliberately NOT source-IP matching: container IPs are reassigned across
 * restarts, so an IP-keyed policy silently transfers one agent's permissions to
 * whichever container next gets its address.
 *
 * The harness hands us SHA-256 hashes of the agent tokens, never the tokens
 * themselves, so a compromised proxy cannot turn around and impersonate an
 * agent against the Blackhouse API.
 *
 * ## Policy freshness
 *
 * Fetched from the harness at boot and every 30s, so an operator's edit in
 * Settings takes effect within one refresh without restarting anything.
 *
 * Boot degrades to the `EGRESS_ALLOWLIST` env fallback rather than failing
 * closed, because a proxy that cannot start is indistinguishable to the user
 * from a broken harness and invites disabling egress control entirely. Once
 * running, a *refresh* failure keeps serving the last known policy — stale is
 * better than absent, and the harness being briefly unreachable is not a signal
 * that the agent's permissions changed.
 *
 * But with no policy from either source, every request is denied. There is no
 * path in this file where "we don't know" means "allow".
 *
 * ## No TLS interception, by decision
 *
 * A CONNECT-level domain allowlist never terminates TLS, so there is no
 * certificate to sign and no CA to install. Shipping a trust root would mean
 * installing it into every image and then again into node, npm, pip, git and
 * curl individually — a large, brittle surface for zero benefit at this level
 * of granularity. If body-level auditing is ever needed, the hook is here: the
 * CONNECT handler would terminate TLS with a generated leaf instead of piping,
 * and `ensureProxyContainer` would have to mount a CA key. Not in v1.
 */

import http from "node:http";
import net from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  checkEgress,
  isBlockedAddress,
  parseTarget,
  ruleIsIpLiteral,
  canonicalizeRules,
} from "./allowlist.mjs";

const PORT = Number(process.env.EGRESS_PROXY_PORT || 3128);
const HOST = "0.0.0.0";
const POLICY_KEY = process.env.EGRESS_POLICY_KEY || "";
const BLACKHOUSE_URL = (process.env.BLACKHOUSE_URL || "").replace(/\/+$/, "");
const PROXY_TOKEN = process.env.EGRESS_PROXY_TOKEN || "";
const REFRESH_MS = Number(process.env.EGRESS_REFRESH_MS || 30_000);
const CONNECT_TIMEOUT_MS = Number(process.env.EGRESS_CONNECT_TIMEOUT_MS || 15_000);

/** Hop-by-hop headers, stripped before relaying a plain-HTTP request upstream. */
const HOP_BY_HOP = new Set([
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * @type {null | {
 *   rules: string[],
 *   agents: Map<string, {tokenHash: string, mode: string}> | null,
 *   source: "harness" | "env-fallback",
 *   fetchedAt: number,
 * }}
 */
let policy = null;

function log(entry) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

function envFallbackRules() {
  const raw = process.env.EGRESS_ALLOWLIST || "";
  return canonicalizeRules(raw.split(/[\s,]+/).filter(Boolean));
}

async function fetchPolicy() {
  if (!BLACKHOUSE_URL || !PROXY_TOKEN) throw new Error("BLACKHOUSE_URL/EGRESS_PROXY_TOKEN unset");
  const url = `${BLACKHOUSE_URL}/api/egress/policy?key=${encodeURIComponent(POLICY_KEY)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${PROXY_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`policy fetch ${res.status}`);
  const body = await res.json();
  const agents = new Map();
  for (const a of Array.isArray(body.agents) ? body.agents : []) {
    if (a && typeof a.id === "string" && typeof a.tokenHash === "string") {
      agents.set(a.id, { tokenHash: a.tokenHash, mode: a.mode === "none" ? "none" : "allowlist" });
    }
  }
  return {
    rules: canonicalizeRules(Array.isArray(body.rules) ? body.rules : []),
    agents,
    source: "harness",
    fetchedAt: Date.now(),
  };
}

async function refreshPolicy({ boot = false } = {}) {
  try {
    policy = await fetchPolicy();
    log({
      event: "policy",
      source: policy.source,
      rules: policy.rules.length,
      agents: policy.agents.size,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!boot) {
      // Keep serving the last known policy. See the header: a transient
      // harness outage is not evidence that permissions changed.
      log({ event: "policy_refresh_failed", error: message, serving: policy?.source ?? "none" });
      return;
    }
    const rules = envFallbackRules();
    if (rules.length > 0) {
      // `agents: null` means "roster unknown" — see `authenticate`.
      policy = { rules, agents: null, source: "env-fallback", fetchedAt: Date.now() };
      log({ event: "policy", source: "env-fallback", rules: rules.length, error: message });
    } else {
      log({ event: "policy_unavailable", error: message });
    }
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Constant-time hex compare that does not leak length via an early return. */
function hexEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Resolve the calling agent from `Proxy-Authorization`.
 * Returns `{ok:true, agentId, mode, verified}` or `{ok:false, reason}`.
 */
function authenticate(req) {
  if (!policy) return { ok: false, reason: "no-policy" };

  const header = req.headers["proxy-authorization"];
  if (!header || Array.isArray(header)) return { ok: false, reason: "no-credentials" };
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!m) return { ok: false, reason: "bad-credentials" };

  let decoded;
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return { ok: false, reason: "bad-credentials" };
  }
  const sep = decoded.indexOf(":");
  if (sep <= 0) return { ok: false, reason: "bad-credentials" };
  const agentId = decoded.slice(0, sep);
  const token = decoded.slice(sep + 1);
  if (token.length === 0) return { ok: false, reason: "bad-credentials" };

  if (policy.agents === null) {
    // Env-fallback boot: we have an allowlist but no roster to check against.
    // Network membership is the only authz available in this window, and it is
    // a per-policy-key internal network — so the allowlist still binds, but we
    // cannot say *which* agent this is. Logged as unverified on every line.
    return { ok: true, agentId, mode: "allowlist", verified: false };
  }

  const entry = policy.agents.get(agentId);
  if (!entry) return { ok: false, reason: "unknown-agent" };
  if (!hexEqual(sha256Hex(token), entry.tokenHash)) return { ok: false, reason: "bad-token" };
  return { ok: true, agentId, mode: entry.mode, verified: true };
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * Full decision for one request. Returns the normalized host/port to dial, so
 * the caller never connects to a string different from the one it checked.
 */
function authorize(req, hostPort) {
  const auth = authenticate(req);
  if (!auth.ok) return { status: 407, reason: auth.reason, agentId: null };

  const target = parseTarget(hostPort);
  if (!target || target.port === null) {
    return { status: 400, reason: "invalid-host", agentId: auth.agentId };
  }

  const verdict = checkEgress(auth.mode, hostPort, policy.rules, target.port);
  if (!verdict.allowed) {
    return { status: 403, reason: verdict.reason, agentId: auth.agentId };
  }

  return {
    status: 200,
    reason: null,
    agentId: auth.agentId,
    verified: auth.verified,
    host: target.host,
    port: target.port,
    rule: verdict.rule,
    // An operator who allowlists a literal private address meant it (an
    // internal registry). A *domain* that resolves into private space is a
    // rebinding attack, and the guard stays on.
    allowPrivate: ruleIsIpLiteral(verdict.rule ?? ""),
  };
}

/**
 * `net.connect`, with the SSRF guard applied to the address we actually
 * reached rather than to a name we resolved beforehand — which is what closes
 * the DNS-rebinding window.
 */
function guardedConnect(decision, onReady, onFail) {
  const socket = net.connect({ host: decision.host, port: decision.port });
  socket.setTimeout(CONNECT_TIMEOUT_MS);
  socket.once("timeout", () => {
    socket.destroy();
    onFail("upstream-timeout");
  });
  socket.once("error", (err) => onFail(err.code || "upstream-error"));
  socket.once("connect", () => {
    socket.setTimeout(0);
    if (!decision.allowPrivate && isBlockedAddress(socket.remoteAddress ?? "")) {
      socket.destroy();
      onFail("private-address");
      return;
    }
    onReady(socket);
  });
  return socket;
}

// ---------------------------------------------------------------------------
// CONNECT — the tunnel path (all HTTPS)
// ---------------------------------------------------------------------------

const server = http.createServer();

server.on("connect", (req, clientSocket, head) => {
  const decision = authorize(req, req.url ?? "");
  const base = {
    event: "connect",
    agent: decision.agentId,
    target: req.url,
    verified: decision.verified ?? false,
  };

  if (decision.status !== 200) {
    log({ ...base, decision: "deny", status: decision.status, reason: decision.reason });
    const extra = decision.status === 407 ? 'Proxy-Authenticate: Basic realm="blackhouse"\r\n' : "";
    clientSocket.end(
      `HTTP/1.1 ${decision.status} ${http.STATUS_CODES[decision.status]}\r\n${extra}` +
        `Connection: close\r\nX-Blackhouse-Egress: ${decision.reason}\r\n\r\n`,
    );
    return;
  }

  guardedConnect(
    decision,
    (upstream) => {
      log({ ...base, decision: "allow", rule: decision.rule });
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      const teardown = () => {
        upstream.destroy();
        clientSocket.destroy();
      };
      upstream.once("error", teardown);
      clientSocket.once("error", teardown);
      upstream.once("close", teardown);
      clientSocket.once("close", teardown);
    },
    (reason) => {
      log({ ...base, decision: "deny", status: 502, reason });
      // The allowlist already said yes, so this is an upstream/guard failure.
      clientSocket.end(
        `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nX-Blackhouse-Egress: ${reason}\r\n\r\n`,
      );
    },
  );

  clientSocket.once("error", () => clientSocket.destroy());
});

// ---------------------------------------------------------------------------
// Plain HTTP — absolute-URI requests, plus our own health endpoint
// ---------------------------------------------------------------------------

function respond(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(body));
}

server.on("request", (req, res) => {
  const url = req.url ?? "";

  // Origin-form requests are addressed to the proxy itself, not through it.
  if (!/^https?:\/\//i.test(url)) {
    if (req.method === "GET" && (url === "/healthz" || url === "/")) {
      return respond(res, 200, {
        ok: true,
        policyKey: POLICY_KEY,
        policy: policy
          ? { source: policy.source, rules: policy.rules.length, fetchedAt: policy.fetchedAt }
          : null,
      });
    }
    return respond(res, 400, { error: "This is a forward proxy; use an absolute URI or CONNECT." });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return respond(res, 400, { error: "Malformed absolute URI" });
  }
  // Only the two HTTP schemes; a `file:` or `ftp:` absolute URI is not ours to
  // fetch, and the allowlist's port model assumes HTTP semantics.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return respond(res, 400, { error: "Unsupported scheme" });
  }

  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  const decision = authorize(req, `${parsed.hostname}:${port}`);
  const base = {
    event: "http",
    agent: decision.agentId,
    method: req.method,
    target: `${parsed.hostname}:${port}`,
    verified: decision.verified ?? false,
  };

  if (decision.status !== 200) {
    log({ ...base, decision: "deny", status: decision.status, reason: decision.reason });
    if (decision.status === 407) res.setHeader("proxy-authenticate", 'Basic realm="blackhouse"');
    res.setHeader("x-blackhouse-egress", String(decision.reason));
    return respond(res, decision.status, { error: "Egress denied", reason: decision.reason });
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }
  headers.host = parsed.host;

  log({ ...base, decision: "allow", rule: decision.rule });

  let failed = false;
  const upstream = http.request(
    {
      host: decision.host,
      port: decision.port,
      method: req.method,
      path: parsed.pathname + parsed.search,
      headers,
      // Reuse the one guarded connector so the SSRF check applies to plain
      // HTTP exactly as it does to CONNECT.
      //
      // The braces are load-bearing: `http.request` uses a socket returned
      // *synchronously* from `createConnection` and ignores the callback
      // afterwards. Returning the pending socket would hand node a connection
      // before the private-address check had run on it. Returning undefined
      // makes node wait for the callback, which only fires post-guard.
      createConnection: (_opts, cb) => {
        guardedConnect(
          decision,
          (socket) => cb(null, socket),
          (reason) => {
            failed = true;
            cb(new Error(reason));
          },
        );
      },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );

  upstream.once("error", (err) => {
    if (!res.headersSent) {
      respond(res, 502, { error: "Upstream failed", reason: failed ? err.message : "upstream" });
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

server.on("clientError", (_err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

await refreshPolicy({ boot: true });
setInterval(() => {
  void refreshPolicy();
}, REFRESH_MS).unref();

server.listen(PORT, HOST, () => {
  log({ event: "listening", port: PORT, policyKey: POLICY_KEY, policy: policy?.source ?? "none" });
});
