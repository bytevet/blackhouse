#!/usr/bin/env node
/**
 * The Blackhouse in-container sidecar.
 *
 * It does one thing: turn the agent CLI's structured session log into the
 * event union the server renders as a channel transcript, and keep the
 * server's idea of "is this agent busy" honest.
 *
 * Zero dependencies, node builtins and global `fetch` only. It is fetched
 * over the wire at boot (see `entrypoint.sh`) and must run on whatever Node
 * the image happens to have, so nothing here may need `npm install`.
 *
 * SHAPE OF THE LOOP
 *
 *   every ~500ms:
 *     tail the session-log directory  -> new complete lines
 *     map each line via the adapter   -> zero or more events
 *     enqueue                          (poster batches + retries + dedups)
 *     flush
 *     post `state` if a transition or the heartbeat is due
 *     persist watermarks
 *
 * Polling, not `fs.watch`: see the note at the top of `lib/tail.mjs`.
 *
 * NOTHING IN THIS PROCESS MAY BE FATAL. If the server is down, if the log
 * directory does not exist yet, if a line is garbage — the loop takes the next
 * tick anyway. The failure mode we accept is a stale transcript. The failure
 * mode we refuse is a sidecar that exited an hour ago and an agent nobody
 * realises has gone dark.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import { createTailer } from "./lib/tail.mjs";
import { createPoster } from "./lib/poster.mjs";
import { createActivityTracker, postState } from "./lib/state.mjs";

const ADAPTERS = {
  "claude-code": () => import("./adapters/claude-code.mjs"),
  // `tests/fixtures/mock-agent-tui.sh` writes Claude-Code-shaped records on
  // purpose, so the credential-free image exercises the real adapter rather
  // than a test-only path that could drift away from it. `BLACKHOUSE_ADAPTER`
  // comes from `blueprint.cli`, which is `mock` for that image.
  mock: () => import("./adapters/claude-code.mjs"),
};

/**
 * CLIs with no structured log get the server-side PTY scraper instead
 * (`server/agents/pty-scrape.ts`). There is deliberately nothing to install
 * for them: emitting no events is a valid, supported configuration, and the
 * server notices the silence and falls back on its own.
 */
function log(...args) {
  const stamp = new Date().toISOString();
  console.error(`[blackhouse-sidecar ${stamp}]`, ...args);
}

function readConfig(env = process.env) {
  const home = env.HOME || "/home/workspace";
  const stateDir = path.join(home, ".cache", "blackhouse-sidecar");
  const base = (env.BLACKHOUSE_URL || "").replace(/\/+$/, "");
  return {
    agentId: env.AGENT_ID || "",
    token: env.AGENT_TOKEN || "",
    handle: env.AGENT_HANDLE || "",
    baseUrl: base,
    eventsUrl: base ? `${base}/api/agent-runtime/events` : "",
    stateUrl: base ? `${base}/api/agent-runtime/state` : "",
    adapterName: env.BLACKHOUSE_ADAPTER || "claude-code",
    stateDir,
    watermarkFile: path.join(stateDir, "watermarks.json"),
    env,
  };
}

async function loadWatermarks(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // First boot, or a corrupt file. Starting from zero is safe: every event
    // carries a deterministic sourceRef, so a full replay dedups server-side.
    return {};
  }
}

async function saveWatermarks(file, watermarks) {
  try {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(watermarks), "utf8");
    await fs.rename(tmp, file);
  } catch (err) {
    log("could not persist watermarks (will replay on restart)", err?.message ?? err);
  }
}

export async function main(env = process.env) {
  const cfg = readConfig(env);

  if (!cfg.agentId || !cfg.token || !cfg.baseUrl) {
    log("AGENT_ID, AGENT_TOKEN and BLACKHOUSE_URL are all required — not starting.");
    log("The agent itself is unaffected; the channel transcript will be empty.");
    return 0;
  }

  const loader = ADAPTERS[cfg.adapterName];
  if (!loader) {
    log(
      `no in-container adapter for "${cfg.adapterName}" — inheriting the ` +
        `server-side PTY scraper. This is expected for codex/antigravity/custom.`,
    );
    return 0;
  }

  let adapter;
  try {
    adapter = (await loader()).default;
  } catch (err) {
    log(`adapter "${cfg.adapterName}" failed to load`, err?.message ?? err);
    return 0;
  }

  await fs.mkdir(cfg.stateDir, { recursive: true }).catch(() => {});

  const roots = adapter.roots(cfg.env);
  log(`adapter=${adapter.name} agent=${cfg.handle || cfg.agentId} roots=${roots.join(",")}`);

  const tailer = createTailer({
    roots,
    filter: adapter.fileFilter,
    onWarn: (msg, err) => log(msg, err?.message ?? err ?? ""),
  });
  tailer.load(await loadWatermarks(cfg.watermarkFile));

  const poster = createPoster({
    url: cfg.eventsUrl,
    agentId: cfg.agentId,
    token: cfg.token,
    adapter: adapter.name,
    log: (msg, err) => log(msg, err?.message ?? err ?? ""),
  });

  const tracker = createActivityTracker({
    idleQuietMs: adapter.profile.idleQuietMs,
    heartbeatMs: adapter.profile.heartbeatMs,
    terminalTypes: adapter.TERMINAL_EVENT_TYPES,
  });

  const stateCfg = { url: cfg.stateUrl, agentId: cfg.agentId, token: cfg.token };

  let seq = 0;
  let running = true;
  let persistedAt = 0;

  const stop = () => {
    running = false;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // A rejection nobody handled must not take the loop down with it.
  process.on("unhandledRejection", (err) => log("unhandled rejection", err));
  process.on("uncaughtException", (err) => log("uncaught exception", err));

  while (running) {
    await tick();
    await sleep(adapter.profile.pollIntervalMs);
  }

  // Best effort on the way out: drain, and say we do not know rather than
  // leaving a stale `busy` that blocks every future dispatch.
  await poster.flush().catch(() => {});
  await postState(stateCfg, { activity: "unknown", at: new Date().toISOString() }).catch(() => {});
  await saveWatermarks(cfg.watermarkFile, tailer.watermarks());
  return 0;

  async function tick() {
    try {
      const lines = await tailer.poll();
      const produced = [];
      for (const item of lines) {
        // `mapLine` is contractually non-throwing, but the contract is with a
        // file format nobody controls, so we belt-and-brace it anyway.
        let result;
        try {
          result = adapter.mapLine({ ...item, seq });
        } catch (err) {
          log("adapter threw (this is a bug — degrading to raw)", err?.message ?? err);
          result = {
            events: [
              {
                sourceRef: `adapter-error:${item.path}:${item.offset}`.slice(0, 200),
                seq,
                type: "raw",
                payload: { adapterError: true, path: item.path, offset: item.offset },
              },
            ],
            nextSeq: seq + 1,
          };
        }
        seq = result.nextSeq;
        for (const event of result.events) {
          poster.enqueue(event);
          produced.push(event);
        }
      }

      tracker.observe(produced);
      await poster.flush();

      const statePayload = tracker.due();
      if (statePayload) await postState(stateCfg, statePayload);

      // Persisting every tick would be 2 writes/second forever. Once a second
      // is plenty: the cost of a stale watermark is a replayed line, which
      // dedups.
      const now = Date.now();
      if (produced.length > 0 && now - persistedAt > 1000) {
        persistedAt = now;
        await saveWatermarks(cfg.watermarkFile, tailer.watermarks());
      }
    } catch (err) {
      // The outermost net. Whatever happened, we take the next tick.
      log("tick failed", err?.message ?? err);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only run when executed directly, so tests can import the module.
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      log("fatal", err);
      process.exit(1);
    },
  );
}
