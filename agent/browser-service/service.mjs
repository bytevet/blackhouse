/**
 * Blackhouse in-container browser service.
 *
 * Launches one headless Chromium page via Playwright and exposes endpoints
 * on 127.0.0.1:9223:
 *
 *   GET  /browser/ws       — WebSocket carrying an H.264 video stream of
 *                            the page. First message is JSON config; each
 *                            following BINARY message is one Access Unit
 *                            with a 9-byte header (type + 8-byte big-endian
 *                            PTS µs) followed by Annex-B bytes.
 *   POST /browser/input    — { type, x, y, button, key, text, deltaY } →
 *                            dispatched via Input.dispatchMouse/KeyEvent /
 *                            Input.insertText.
 *   POST /browser/control  — { action: navigate|back|forward|reload, url? }
 *                            or { action: "resize", width, height } (200ms
 *                            debounced; rebroadcasts a new `config` JSON
 *                            and force-keyframes on next emitted AU).
 *   POST /browser/eval     — Runtime.evaluate; result/error also broadcast
 *                            on the /browser/console SSE channel.
 *   GET  /browser/console  — SSE multiplex of `console`, `eval`, `navigate`,
 *                            and `ping` events.
 *   GET  /browser/health   — `{ok, url, streaming, codedWidth, codedHeight}`
 *   GET  /browser/state    — strict e2e probe: queries the live page via CDP
 *                            `Runtime.evaluate` and returns selectionText,
 *                            scrollX/Y, viewport, docSize, lastContextMenu
 *                            (captured by a one-shot listener), etc.
 *                            `?resetContextMenu=1` clears the contextmenu
 *                            slot before reading.
 *
 * Pipeline: CDP `Page.startScreencast` (jpeg q80) → ffmpeg per peer
 *   (`-f image2pipe -c:v mjpeg -i pipe:0` in, libx264 zerolatency Annex-B
 *    out with AUD NALU at every AU boundary) → parser splits on AUDs and
 *    detects keyframes by scanning for IDR slice NALUs → WS send.
 *
 * Per-peer ffmpeg (rather than a single shared encoder) keeps the late-join
 * keyframe semantics trivial: every new peer's encoder emits an IDR on its
 * first output frame, so we never have to flag-down a global encoder for a
 * forced keyframe or block a subscriber until the next natural one.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { streamSSE } from "hono/streaming";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import ffmpegPath from "ffmpeg-static";
import { decode as decodeInput } from "./input-codec.mjs";

// Surface immediately at boot so we never silently lose ffmpeg later. If
// ffmpeg-static didn't successfully run its post-install (e.g. the image
// was built with `npm install --ignore-scripts` somewhere up the chain),
// the binary will be missing and every peer will fail to spawn an encoder.
if (!ffmpegPath) {
  console.error("[browser-service] ffmpeg-static did not resolve a binary path");
} else if (!fs.existsSync(ffmpegPath)) {
  console.error(`[browser-service] ffmpeg binary missing at ${ffmpegPath}`);
} else {
  console.log(`[browser-service] ffmpeg binary: ${ffmpegPath}`);
}

const PORT = Number(process.env.BROWSER_SERVICE_PORT || 9223);
// Bind to 0.0.0.0 inside the container so Podman/Docker port mapping can
// forward host traffic to us — services on the container's loopback aren't
// reachable via the bridge interface. The Blackhouse server constrains
// external exposure with `HostIp: "127.0.0.1"` on the host-side port binding.
const HOST = "0.0.0.0";
const DEFAULT_URL = process.env.BROWSER_DEFAULT_URL || "about:blank";

// Screencast tuning.
//
// `everyNthFrame: N` tells CDP "emit every Nth paint Chromium internally
// produces" — NOT "emit N frames per second". Static pages paint only once
// or twice (initial render + reflow), so any N > 2 yields ZERO frames in
// the viewer. Interactive pages naturally produce many paints per second,
// so Chromium itself ends up being the throttle. We forward every paint and
// let bandwidth scale with page activity.
//
// JPEG quality is bumped to 80 (vs the old 60) since the lossy JPEG is now
// being re-encoded into H.264 downstream — keeping more detail at the
// source costs ~30 KB more per frame but reduces compounding artifacts.
// Mutable: updated when the client requests a viewport resize (#41).
// Encoder is re-spawned and CDP `Page.startScreencast` is re-issued at the
// new size; the WS protocol re-broadcasts a fresh `config` JSON so the
// VideoDecoder reconfigures.
let SCREENCAST_WIDTH = 1280;
let SCREENCAST_HEIGHT = 720;

// Clamp range for resize requests. libx264 also requires even W/H — we
// floor to the nearest even value in `clampDims` rather than reject.
const RESIZE_MIN_W = 320;
const RESIZE_MIN_H = 240;
const RESIZE_MAX_W = 3840;
const RESIZE_MAX_H = 2160;

function makeScreencastConfig() {
  return {
    format: "jpeg",
    quality: 80,
    maxWidth: SCREENCAST_WIDTH,
    maxHeight: SCREENCAST_HEIGHT,
    everyNthFrame: 1,
  };
}

function clampDims(width, height) {
  const w = Math.max(RESIZE_MIN_W, Math.min(RESIZE_MAX_W, Math.floor(width)));
  const h = Math.max(RESIZE_MIN_H, Math.min(RESIZE_MAX_H, Math.floor(height)));
  // libx264 baseline requires even dimensions.
  return { width: w - (w & 1), height: h - (h & 1) };
}

// avc1.42E01F = H.264 Baseline profile (0x42), constraints (0xE0), level
// 3.1 (0x1F). Matches the `-profile:v baseline -level 3.1` we pass to
// libx264 below. The client uses this string verbatim for
// `VideoDecoder.configure({ codec })`.
const H264_CODEC_STRING = "avc1.42E01F";

// Synthetic monotonic PTS. WebCodecs `VideoDecoder` needs monotonic
// timestamps but doesn't care about real wall-clock alignment. ~30 FPS.
const PTS_INCREMENT_US = 33_333n;

// In-memory ring of recent events (console messages + navigations), replayed
// on SSE connect so a late subscriber still sees what happened just before
// they joined. Each entry is `{ type, payload }` where `type` becomes the
// SSE event name on the wire (`console` | `navigate`).
const EVENT_BUFFER_LIMIT = 200;
const eventBuffer = [];
const eventSubscribers = new Set();

/**
 * Inject a one-shot debug hook into the current page that captures
 * `contextmenu` events on `window.__lastCM`. Re-injected after every main
 * frame navigation. /browser/state reads this back so e2e can verify
 * right-click actually synthesized a contextmenu in the DOM (instead of
 * just verifying that mouseDown:right reached the wire).
 */
async function installDebugHooks(cdp) {
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      if (window.__bhDebugInstalled) return;
      window.__bhDebugInstalled = true;
      window.__lastCM = null;
      window.addEventListener("contextmenu", (e) => {
        window.__lastCM = {
          fired: true,
          x: e.clientX,
          y: e.clientY,
          ts: Date.now(),
          defaultPrevented: e.defaultPrevented,
          buttonInDOM: e.button,
        };
      }, true);
    })()`,
    returnByValue: true,
  });
}

function emitEvent(type, payload) {
  const item = { type, payload };
  eventBuffer.push(item);
  if (eventBuffer.length > EVENT_BUFFER_LIMIT) eventBuffer.shift();
  for (const subscriber of eventSubscribers) {
    try {
      subscriber(item);
    } catch {
      eventSubscribers.delete(subscriber);
    }
  }
}

async function startBrowser() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: { width: SCREENCAST_WIDTH, height: SCREENCAST_HEIGHT },
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // Console / exception → emitted as `console` SSE events
  cdp.on("Runtime.consoleAPICalled", (params) => {
    const text = (params.args || [])
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? "")
      .join(" ");
    emitEvent("console", {
      level: params.type || "log",
      text,
      url: params.stackTrace?.callFrames?.[0]?.url,
      line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      ts: Date.now(),
    });
  });
  cdp.on("Runtime.exceptionThrown", (params) => {
    const e = params.exceptionDetails;
    emitEvent("console", {
      level: "error",
      text: e?.exception?.description || e?.text || "exception",
      url: e?.url,
      line: e?.lineNumber,
      ts: Date.now(),
    });
  });

  // Main-frame navigation → emitted as `navigate` SSE events. The React
  // address bar listens for these so it reflects whatever URL the agent
  // navigated to (via `browser.sh navigate` or the BROWSER shim).
  // `parentId` is undefined on the top frame; we filter sub-frame navigations
  // (iframes, ads) out so the address bar shows the page URL only.
  cdp.on("Page.frameNavigated", (params) => {
    if (params.frame?.parentId) return;
    const url = params.frame?.url;
    if (!url || url === "about:blank") return;
    emitEvent("navigate", { url, ts: Date.now() });
    // Re-install the contextmenu listener after every navigation. Page
    // navigations wipe DOM listeners; the listener is what /browser/state
    // reads to verify right-click actually synthesized a contextmenu event.
    // Fire-and-forget; harmless if injection fails.
    installDebugHooks(cdp).catch(() => {});
  });

  // Set of active per-peer encoder streams. Each holds an ffmpeg child
  // process taking JPEGs in and producing H.264 Annex-B out (see
  // `H264PeerStream` below). The CDP screencast itself is shared (one
  // `Page.startScreencast` invocation drives all peers); we fan the JPEG
  // bytes out to each peer's ffmpeg stdin.
  const peers = new Set();
  let screencastRunning = false;

  async function ensureScreencastRunning() {
    if (screencastRunning) return;
    screencastRunning = true;
    await cdp.send("Page.startScreencast", makeScreencastConfig());
    // Push the current page URL as a synthetic `navigate` event so the
    // React address bar populates immediately on first connect — even when
    // the page is still on the default `about:blank` (which the
    // `Page.frameNavigated` handler filters out to avoid noise). This event
    // lands in `eventBuffer`, so later SSE subscribers see it via the
    // replay path too.
    emitEvent("navigate", { url: page.url(), ts: Date.now() });
  }

  async function stopScreencastIfIdle() {
    if (peers.size > 0 || !screencastRunning) return;
    screencastRunning = false;
    try {
      await cdp.send("Page.stopScreencast");
    } catch {
      // already stopped or page closed
    }
  }

  // ── Resize: tear down + restart encoders at a new viewport size. ──────
  // 200ms debounce so dragging the window doesn't thrash the encoder; the
  // last requested size within the window wins. While a resize is running,
  // additional incoming sizes get queued through the same debounce — if a
  // new size arrives during the actual restart, the timer reschedules and
  // we re-resize after the current one completes.
  let pendingResizeDims = null;
  let resizeTimer = null;
  let resizeInFlight = false;

  async function runResize(width, height) {
    resizeInFlight = true;
    try {
      // 1. Stop the CDP screencast so no late frames arrive while we shuffle.
      if (screencastRunning) {
        try {
          await cdp.send("Page.stopScreencast");
        } catch {
          // already stopped — fine
        }
        screencastRunning = false;
      }
      // 2. Tear down all peer encoders. The WS connections stay up; we'll
      //    attach fresh H264PeerStreams below. Snapshot first because we
      //    mutate `peers`.
      const peerWss = [];
      for (const p of [...peers]) {
        peerWss.push(p.ws);
        peers.delete(p);
        try {
          p.close();
        } catch {
          /* already closed */
        }
      }
      // 3. Update Playwright viewport. This also resizes the underlying CDP
      //    page so subsequent screencast frames are at the new resolution.
      await page.setViewportSize({ width, height });
      SCREENCAST_WIDTH = width;
      SCREENCAST_HEIGHT = height;
      // 4. Recreate per-peer encoders + tell each peer about the new codec
      //    config so it can reconfigure its VideoDecoder before the next
      //    binary chunk lands (which will be a fresh keyframe).
      for (const ws of peerWss) {
        if (ws._h264 == null) continue; // peer disconnected mid-resize
        try {
          ws.send(
            JSON.stringify({
              type: "config",
              codec: H264_CODEC_STRING,
              codedWidth: SCREENCAST_WIDTH,
              codedHeight: SCREENCAST_HEIGHT,
            }),
          );
        } catch {
          continue; // peer gone
        }
        const fresh = new H264PeerStream(ws);
        ws._h264 = fresh;
        peers.add(fresh);
      }
      // 5. Restart the CDP screencast at the new size if anyone's listening.
      if (peers.size > 0) {
        try {
          await cdp.send("Page.startScreencast", makeScreencastConfig());
          screencastRunning = true;
        } catch (err) {
          console.error(`[resize] Page.startScreencast failed: ${err?.message || err}`);
          // Don't leave the flag set — next ensureScreencastRunning gets a
          // chance to retry.
          screencastRunning = false;
        }
      }
    } catch (err) {
      console.error(`[resize] unexpected failure: ${err?.stack || err}`);
    } finally {
      resizeInFlight = false;
    }
  }

  function scheduleResize(rawWidth, rawHeight) {
    const dims = clampDims(rawWidth, rawHeight);
    pendingResizeDims = dims;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      resizeTimer = null;
      if (resizeInFlight) {
        // Another resize is already running; the trailing edge of THIS
        // request will re-fire when the next scheduleResize arrives. Be
        // pragmatic: reschedule a short follow-up so we don't drop the
        // final dimensions if nothing else arrives.
        resizeTimer = setTimeout(() => scheduleResize(dims.width, dims.height), 100);
        return;
      }
      const d = pendingResizeDims;
      pendingResizeDims = null;
      if (!d) return;
      try {
        await runResize(d.width, d.height);
      } catch (err) {
        console.error("[resize] failed:", err);
      }
    }, 200);
  }

  cdp.on("Page.screencastFrame", async (params) => {
    // Decode the base64 JPEG once; feed the bytes to each peer's ffmpeg
    // stdin. Annex-B chunks come back asynchronously via the stdout parser
    // inside H264PeerStream.
    const bytes = Buffer.from(params.data, "base64");
    for (const peer of peers) {
      try {
        peer.pushJpeg(bytes);
      } catch {
        peers.delete(peer);
      }
    }
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId });
    } catch {
      // page closed mid-frame; ignore
    }
  });

  // Navigate to the default URL so the first connect has something to render.
  page.goto(DEFAULT_URL).catch(() => {
    /* default may be unreachable; that's fine — about:blank works */
  });

  return {
    browser,
    context,
    page,
    cdp,
    peers,
    ensureScreencastRunning,
    stopScreencastIfIdle,
    scheduleResize,
  };
}

const state = await startBrowser();

// ---------- Per-peer H.264 encoder stream ------------------------------------

/**
 * Wraps one WS peer: ffmpeg encoder + Annex-B parser + PTS counter.
 *
 * ffmpeg consumes JPEGs from stdin (-f image2pipe -c:v mjpeg) and emits a
 * raw H.264 elementary stream on stdout, with libx264's `-tune zerolatency`
 * (no lookahead) and the `h264_metadata=aud=insert` bitstream filter so
 * every Access Unit starts with an AUD NALU. The AUD start code
 * `00 00 00 01 09` is our reliable AU boundary.
 *
 * For each AU:
 *   - Walk NALUs (split on start codes) and look for IDR slice (nal_type=5)
 *     to flag keyframes.
 *   - Don't emit a delta to the wire before the first key has been sent —
 *     belt-and-suspenders, since ffmpeg's first emitted frame is always an
 *     IDR anyway.
 *   - Prepend a 9-byte header `[type:u8 | pts:u64-BE]` and ship.
 */
// Module-scoped sequence number for log correlation — useful when multiple
// peers connect close in time and their exit logs interleave.
let _peerStreamSeq = 0;

class H264PeerStream {
  constructor(ws) {
    this.ws = ws;
    this.buf = Buffer.alloc(0);
    this.pts = 0n;
    this.firstKeyEmitted = false;
    this.closed = false;
    this.id = ++_peerStreamSeq;
    if (!ffmpegPath) {
      console.error(`[peer ${this.id}] cannot spawn encoder: ffmpegPath is null`);
      this.spawnFailed = true;
      return;
    }
    this.ffmpeg = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        // NOTE: `-fflags +nobuffer+flush_packets` looks like a sensible
        // low-latency input flag, but on the image2pipe demuxer it prevents
        // the demuxer from buffering enough to identify JPEG SOI/EOI markers
        // — empirically produces ZERO encoded output. Verified by a/b
        // isolation: same pipeline minus that flag emits ~4KB for 30 input
        // JPEGs; with the flag, 0 bytes. Keep the output-side `-flush_packets
        // 1` (below) which is the actual latency lever we need.
        "-flags",
        "low_delay",
        // ffmpeg's image2pipe demuxer buffers `probesize` bytes (default 5 MB)
        // or `analyzeduration` (default 5 s) before deciding stream params.
        // In the headless container Chromium produces 3–5 KB JPEGs (no GPU)
        // — at ~30 fps that's 30–60 s to fill the default probe even on an
        // active page; for a near-static page it can take forever. Result:
        // ffmpeg sits at 0 % CPU forever, stdin filling, never decoding.
        // Set tiny values so the demuxer commits after the first JPEG.
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "-i",
        "pipe:0",
        "-c:v",
        "libx264",
        "-tune",
        "zerolatency",
        "-preset",
        "ultrafast",
        "-profile:v",
        "baseline",
        "-level",
        "3.1",
        "-pix_fmt",
        "yuv420p",
        // 2-second keyframe interval (at 30 FPS = every 60 frames). Was 30
        // (1s) — at JPEG q80 baseline the keyframe is ~10–15× a delta, so
        // halving the rate cuts bandwidth roughly 30–40% for typical
        // interactive use. Trade-off: packet-loss recovery takes up to 2 s
        // instead of 1, which is fine over the reliable WS/TCP transport.
        "-g",
        "60",
        "-keyint_min",
        "60",
        "-bf",
        "0",
        "-refs",
        "1",
        // Flush the muxer / pipe after every packet so each encoded frame
        // hits the WS immediately. Without this ffmpeg block-buffers stdout
        // and the viewer waits seconds-to-forever for the first frame.
        "-flush_packets",
        "1",
        "-f",
        "h264",
        "-bsf:v",
        "h264_metadata=aud=insert",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    // Note: `pid` is set on the ChildProcess synchronously, but the actual
    // fork may not have happened yet — the 'spawn' event is the authoritative
    // signal that the child is alive.
    this.ffmpeg.on("spawn", () => {
      console.log(`[peer ${this.id}] ffmpeg up pid=${this.ffmpeg.pid}`);
    });
    this.ffmpeg.on("error", (err) => {
      // Fires when the spawn itself fails (ENOENT, EACCES, etc.) — these
      // would otherwise crash the process as an unhandled emitter error.
      console.error(`[peer ${this.id}] ffmpeg spawn error: ${err.message}`);
      this.spawnFailed = true;
      try {
        this.ws.close(1011, "encoder_spawn_failed");
      } catch {
        /* already closed */
      }
    });
    this.ffmpeg.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.ffmpeg.stderr.on("data", (chunk) => {
      // Surface real errors; rate-limit so we don't drown the log.
      const line = chunk.toString().trim();
      if (line)
        console.error(`[peer ${this.id} ffmpeg:stderr]`, line.split("\n").slice(0, 3).join(" | "));
    });
    this.ffmpeg.on("exit", (code, signal) => {
      if (!this.closed) {
        console.error(`[peer ${this.id}] ffmpeg exited code=${code} signal=${signal}`);
        try {
          this.ws.close(1011, "encoder_exit");
        } catch {
          /* already closed */
        }
      }
    });
    this.ffmpeg.stdin.on("error", (err) => {
      // EPIPE on a writer happens after the child exits; cleanup runs via
      // the `exit` handler. Log anyway so we can spot encoder crashes early.
      if (!this.closed && err.code !== "EPIPE") {
        console.error(`[peer ${this.id}] ffmpeg stdin error: ${err.message}`);
      }
    });
  }

  pushJpeg(jpegBytes) {
    if (this.closed || this.spawnFailed) return;
    if (!this.ffmpeg?.stdin?.writable) {
      if (!this._loggedNoStdin) {
        console.error(`[peer ${this.id}] pushJpeg: stdin not writable`);
        this._loggedNoStdin = true;
      }
      return;
    }
    const ok = this.ffmpeg.stdin.write(jpegBytes);
    if (!ok && !this._loggedDrain) {
      // Back-pressure on the encoder's stdin is the first sign the WS
      // peer can't keep up with the JPEG fan-out. One-shot to avoid a flood.
      console.warn(`[peer ${this.id}] ffmpeg stdin back-pressure`);
      this._loggedDrain = true;
    }
    this._lastJpeg = jpegBytes;
    this._scheduleJpegHeartbeat();
  }

  /**
   * The mjpeg/image2pipe demuxer holds each input frame until the *next*
   * one arrives — it uses the follow-on SOI marker to know the previous
   * frame is complete. On a near-static page (e.g. the user just navigated
   * to example.com and is sitting there), Chromium only emits 1-2 paints
   * total, so the latest paint never reaches the encoder. ffmpeg sits at
   * 0% CPU, stdin filling, never producing stdout.
   *
   * Workaround: 200 ms after the most recent JPEG push, if nothing new
   * has arrived, re-push the same JPEG. ffmpeg treats it as the next
   * frame, encodes the prior one, and writes it to stdout. The re-pushed
   * frame stays "pending" — but the next tick will flush it too. Result:
   * steady ~5 fps stream of (mostly) delta frames on idle pages (a few
   * hundred bytes each), zero latency cost on active pages because real
   * paints reset the timer before it fires.
   */
  _scheduleJpegHeartbeat() {
    if (this._jpegHeartbeatTimer) clearTimeout(this._jpegHeartbeatTimer);
    this._jpegHeartbeatTimer = setTimeout(() => {
      this._jpegHeartbeatTimer = null;
      if (this.closed || !this._lastJpeg) return;
      if (!this.ffmpeg?.stdin?.writable) return;
      this.ffmpeg.stdin.write(this._lastJpeg);
      this._scheduleJpegHeartbeat();
    }, 200);
  }

  _onStdout(chunk) {
    // Accumulate, then walk AUD-delimited Access Units.
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    for (;;) {
      // Need at least one AUD start to begin.
      const first = findAudStart(this.buf, 0);
      if (first < 0) {
        // Buffer holds nothing useful yet.
        if (this._flushTimer) {
          clearTimeout(this._flushTimer);
          this._flushTimer = null;
        }
        return;
      }
      // Look for the *next* AUD to know the AU's end.
      const next = findAudStart(this.buf, first + 5);
      if (next < 0) {
        // The buffer starts with an AUD but we haven't seen the next one
        // yet — so this AU may or may not be complete. In high-motion the
        // next chunk usually arrives within a few ms and contains the
        // delimiting AUD; in low-motion (e.g. example.com is essentially
        // static after the initial paint) we'd wait forever and never emit
        // anything. Schedule a short deferred flush: if no follow-on AUD
        // shows up, treat the buffer as one complete AU and ship it.
        //
        // ffmpeg's `-flush_packets 1` guarantees each packet (= one frame =
        // one AU) is fully flushed before another can land, so a buffer
        // that starts with an AUD and hasn't grown for a few ticks is in
        // fact a complete AU. Empirically this gives 0 ms added latency in
        // animated pages (timer is reset before it fires) and ~50 ms in
        // static pages (acceptable for a real-time preview).
        if (first > 0) this.buf = this.buf.subarray(first);
        this._scheduleDeferredFlush();
        return;
      }
      // We have a complete AUD-bounded AU. Emit and continue the loop in
      // case the buffer holds further AUs (back-to-back packets).
      if (this._flushTimer) {
        clearTimeout(this._flushTimer);
        this._flushTimer = null;
      }
      const au = this.buf.subarray(first, next);
      this.buf = this.buf.subarray(next);
      this._emitAu(au);
    }
  }

  _scheduleDeferredFlush() {
    if (this._flushTimer) return; // already armed
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      if (this.closed) return;
      if (this.buf.length === 0) return;
      if (findAudStart(this.buf, 0) !== 0) return;
      const au = this.buf;
      this.buf = Buffer.alloc(0);
      this._emitAu(au);
    }, 50);
  }

  _emitAu(au) {
    if (this.closed) return;
    const isKey = auContainsIdr(au);
    if (!this.firstKeyEmitted && !isKey) {
      // Drop deltas that arrive before the first IDR. libx264 emits an IDR
      // first by construction, so this should be a no-op in practice.
      return;
    }
    if (isKey) this.firstKeyEmitted = true;

    const header = Buffer.alloc(9);
    header[0] = isKey ? 0 : 1;
    header.writeBigUInt64BE(this.pts, 1);
    this.pts += PTS_INCREMENT_US;

    try {
      this.ws.send(Buffer.concat([header, au]));
    } catch (err) {
      if (!this._loggedSendErr) {
        console.error(`[peer ${this.id}] ws.send threw:`, err?.message || err);
        this._loggedSendErr = true;
      }
      this.close();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._jpegHeartbeatTimer) {
      clearTimeout(this._jpegHeartbeatTimer);
      this._jpegHeartbeatTimer = null;
    }
    if (!this.ffmpeg) return;
    try {
      this.ffmpeg.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      this.ffmpeg.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }
}

/**
 * Find the next AUD NALU start sequence (`00 00 00 01 09` — 4-byte start
 * code + AUD NAL header where nal_unit_type=9). Returns -1 if not found.
 *
 * libx264's `aud=insert` writes the 4-byte start code variant, so we don't
 * scan for the 3-byte form here — sticking to the longer pattern avoids
 * false positives inside compressed slice payloads.
 */
function findAudStart(buf, from) {
  for (let i = from; i + 4 < buf.length; i++) {
    if (
      buf[i] === 0x00 &&
      buf[i + 1] === 0x00 &&
      buf[i + 2] === 0x00 &&
      buf[i + 3] === 0x01 &&
      buf[i + 4] === 0x09
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * True if the AU contains an IDR slice (nal_unit_type=5). Walks NALUs
 * separated by 3- or 4-byte start codes.
 */
function auContainsIdr(au) {
  for (let i = 0; i + 3 < au.length; i++) {
    let nalHeaderIdx;
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 0 && au[i + 3] === 1) {
      nalHeaderIdx = i + 4;
      i += 3;
    } else if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      nalHeaderIdx = i + 3;
      i += 2;
    } else {
      continue;
    }
    if (nalHeaderIdx >= au.length) continue;
    const nalType = au[nalHeaderIdx] & 0x1f;
    if (nalType === 5) return true;
  }
  return false;
}

const app = new Hono();
const nodeWs = createNodeWebSocket({ app });
const { injectWebSocket, upgradeWebSocket } = nodeWs;
// Disable permessage-deflate: H.264 chunks are already entropy-coded, so
// compression is pure CPU overhead. Bilateral with the Blackhouse proxy
// upstream connection (which also opts out). Mutating `wss.options`
// works because the `ws` package reads it at handshake time. (#59 item 3.)
nodeWs.wss.options.perMessageDeflate = false;

// ---------- WebSocket: H.264 video stream ------------------------------------

app.get(
  "/browser/ws",
  upgradeWebSocket(() => ({
    async onOpen(_evt, ws) {
      console.log(
        `[ws] onOpen size=${SCREENCAST_WIDTH}x${SCREENCAST_HEIGHT} peers-before=${state.peers.size}`,
      );
      // 1) Tell the client the codec + dimensions before any binary frames.
      try {
        ws.send(
          JSON.stringify({
            type: "config",
            codec: H264_CODEC_STRING,
            codedWidth: SCREENCAST_WIDTH,
            codedHeight: SCREENCAST_HEIGHT,
          }),
        );
      } catch (err) {
        console.error(`[ws] failed to send initial config: ${err}`);
        return; // peer already disconnected
      }
      // 2) Stand up the per-peer encoder and register it for JPEG fan-out.
      let stream;
      try {
        stream = new H264PeerStream(ws);
      } catch (err) {
        console.error(`[ws] H264PeerStream construction threw: ${err?.stack || err}`);
        try {
          ws.close(1011, "encoder_init_failed");
        } catch {
          /* already closed */
        }
        return;
      }
      ws._h264 = stream;
      state.peers.add(stream);
      console.log(`[ws] peer ${stream.id} registered; peers=${state.peers.size}`);
      // 3) Start the CDP screencast if no other peer already did.
      try {
        await state.ensureScreencastRunning();
      } catch (err) {
        console.error(`[ws] ensureScreencastRunning failed: ${err}`);
        try {
          ws.send(JSON.stringify({ error: "screencast_start_failed", message: String(err) }));
        } catch {
          /* peer gone */
        }
      }
    },
    // Client→server input frames arrive on this same WS:
    //
    //   • Binary frame: compact opcode-prefixed encoding (see
    //     `input-codec.mjs` for the table). Preferred path — 6 B for a
    //     mouseMove vs ~80 B of JSON.
    //   • Text frame:  legacy JSON envelope `{type:"input", input:{...}}`.
    //     Kept as a fallback for clients that haven't shipped the binary
    //     codec yet, and for forward-compat with any non-codec event.
    //
    // The proxy WS just byte-pipes both kinds through. browser-service
    // handles them in receive order, so a mouseMove can't beat its
    // mouseDown to CDP (WS framing preserves order; CDP dispatches are
    // sequential by virtue of being awaited).
    async onMessage(evt, _ws) {
      const message = evt.data;
      if (typeof message === "string") {
        let envelope;
        try {
          envelope = JSON.parse(message);
        } catch {
          return;
        }
        if (!envelope || typeof envelope !== "object" || envelope.type !== "input") return;
        await dispatchInput(envelope.input);
        return;
      }
      // Binary path. `evt.data` is an ArrayBuffer / Buffer / Uint8Array
      // depending on `ws` package config; the codec accepts all three.
      const payload = decodeInput(message);
      if (!payload) return;
      await dispatchInput(payload);
    },
    onClose(_evt, ws) {
      const stream = ws._h264;
      if (stream) {
        state.peers.delete(stream);
        stream.close();
        console.log(`[ws] peer ${stream.id} closed; peers=${state.peers.size}`);
      } else {
        console.log("[ws] onClose with no _h264 attached");
      }
      state.stopScreencastIfIdle().catch(() => {});
    },
  })),
);

// ---------- Input dispatch (shared by REST + WS) ----------------------------
//
// Dispatch a single input payload to CDP. Used by:
//   - POST /browser/input  (fallback REST path; e2e direct-probe uses it)
//   - The /browser/ws message handler when a `{type:"input", input:...}`
//     JSON text frame arrives — saves the localhost HTTP round-trip that
//     the proxy used to take per event.
//
// Returns `{ ok: true }` on success or `{ ok: false, error, status }` on
// validation failure or CDP error. The WS path discards the result; the
// REST path serializes it to a Hono response.
//
// CDP `buttons` is the bitmask of currently-held mouse buttons (1=left,
// 2=right, 4=middle). Without it, every `mouseMoved` during a drag is
// classified as a *hover* by Chromium — so text-selection highlight never
// renders. Likewise, `button` on `mouseMoved` must be the held button name
// when buttons!=0 (not omitted/"none") — verified empirically in #45.
async function dispatchInput(body) {
  if (!body || typeof body !== "object" || typeof body.type !== "string") {
    return { ok: false, error: "invalid_body", status: 400 };
  }
  try {
    switch (body.type) {
      case "mouseMove": {
        const buttons = body.buttons ?? 0;
        // Match Playwright's `_lastButton` semantics for the held-button name.
        const buttonFromBitmask =
          buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : "none";
        await state.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: body.x ?? 0,
          y: body.y ?? 0,
          buttons,
          button: body.button || buttonFromBitmask,
        });
        break;
      }
      case "mouseDown":
        await state.cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: body.x ?? 0,
          y: body.y ?? 0,
          button: body.button || "left",
          buttons: body.buttons ?? 0,
          clickCount: body.clickCount ?? 1,
        });
        break;
      case "mouseUp":
        await state.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: body.x ?? 0,
          y: body.y ?? 0,
          button: body.button || "left",
          buttons: body.buttons ?? 0,
          clickCount: body.clickCount ?? 1,
        });
        break;
      case "wheel":
        await state.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: body.x ?? 0,
          y: body.y ?? 0,
          deltaX: body.deltaX ?? 0,
          deltaY: body.deltaY ?? 0,
        });
        break;
      case "keyDown":
        await state.cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: body.key,
          code: body.code,
          text: body.text,
          modifiers: body.modifiers ?? 0,
        });
        break;
      case "keyUp":
        await state.cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: body.key,
          code: body.code,
          modifiers: body.modifiers ?? 0,
        });
        break;
      case "char":
        if (typeof body.text !== "string") {
          return { ok: false, error: "missing_text", status: 400 };
        }
        await state.cdp.send("Input.insertText", { text: body.text });
        break;
      default:
        return { ok: false, error: "unknown_type", status: 400 };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "cdp_error", message: String(err), status: 500 };
  }
}

app.post("/browser/input", async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = await dispatchInput(body);
  if (result.ok) return c.json({ ok: true });
  return c.json({ error: result.error, message: result.message }, result.status);
});

// ---------- POST /browser/control --------------------------------------------

app.post("/browser/control", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.action !== "string") {
    return c.json({ error: "invalid_body" }, 400);
  }
  try {
    switch (body.action) {
      case "navigate":
        if (typeof body.url !== "string") return c.json({ error: "missing_url" }, 400);
        await state.page.goto(body.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        break;
      case "back":
        await state.page.goBack();
        break;
      case "forward":
        await state.page.goForward();
        break;
      case "reload":
        await state.page.reload();
        break;
      case "resize": {
        if (typeof body.width !== "number" || typeof body.height !== "number") {
          return c.json({ error: "missing_dims" }, 400);
        }
        // Fire-and-forget: scheduleResize debounces 200 ms and runs async.
        // Respond with the clamped target so the FE can sanity-check.
        const dims = clampDims(body.width, body.height);
        state.scheduleResize(dims.width, dims.height);
        return c.json({ ok: true, url: state.page.url(), width: dims.width, height: dims.height });
      }
      default:
        return c.json({ error: "unknown_action" }, 400);
    }
    return c.json({ ok: true, url: state.page.url() });
  } catch (err) {
    return c.json({ error: "nav_failed", message: String(err) }, 500);
  }
});

// ---------- POST /browser/eval -----------------------------------------------
//
// Runs a JS expression in the embedded page via CDP `Runtime.evaluate` and
// returns the stringified result. Also emits an `eval` SSE event so the
// React Console panel can render the result inline with `console.log`
// output — keeping the panel feeling like a real DevTools console.
//
// The FE echoes the *input* optimistically (one `eval` entry with
// `kind:"input"`) — we don't re-emit it on the SSE channel to avoid
// duplicates. We do emit a `result` or `error` entry.

app.post("/browser/eval", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.expression !== "string") {
    return c.json({ ok: false, error: { description: "invalid_body" } }, 400);
  }
  const expression = body.expression;

  try {
    const evalResp = await state.cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      generatePreview: true,
      // Use the `console` object group + user gesture so this looks identical
      // to DevTools console evaluation (lets you e.g. trigger `confirm()`).
      objectGroup: "console",
      includeCommandLineAPI: true,
      userGesture: true,
    });

    if (evalResp.exceptionDetails) {
      const e = evalResp.exceptionDetails;
      const description = e.exception?.description || e.text || "exception";
      const stack = e.stackTrace
        ? e.stackTrace.callFrames
            ?.map((f) => `  at ${f.functionName || "<anonymous>"} (${f.url}:${f.lineNumber})`)
            .join("\n")
        : undefined;
      emitEvent("eval", { kind: "error", text: description, ts: Date.now() });
      return c.json({ ok: false, error: { description, stack } });
    }

    // Stringify the result. `returnByValue: true` populates `value` for
    // serializable types; fall back to the remote object's `description`
    // for non-serializable values (functions, DOM nodes, etc.).
    const remote = evalResp.result;
    let text;
    if (remote.type === "undefined") {
      text = "undefined";
    } else if (remote.value !== undefined) {
      try {
        text = typeof remote.value === "string" ? remote.value : JSON.stringify(remote.value);
      } catch {
        text = String(remote.value);
      }
    } else {
      text = remote.description || remote.type;
    }
    emitEvent("eval", { kind: "result", text, ts: Date.now() });
    return c.json({ ok: true, result: text });
  } catch (err) {
    const description = err instanceof Error ? err.message : String(err);
    emitEvent("eval", { kind: "error", text: description, ts: Date.now() });
    return c.json({ ok: false, error: { description } }, 500);
  }
});

// ---------- GET /browser/console (SSE) ---------------------------------------
//
// Despite the legacy `/console` path, this stream multiplexes multiple SSE
// event types — the client distinguishes via `event:` names:
//   - `console`  — `{level, text, url?, line?, ts}`
//   - `navigate` — `{url, ts}` (main-frame navigations)
//   - `eval`     — `{kind: "result" | "error", text, ts}` (results of
//                   `POST /browser/eval` invocations; `input` echoes are
//                   produced FE-side and not sent on the wire)
//   - `ping`     — heartbeat (no payload)

app.get("/browser/console", (c) =>
  streamSSE(c, async (stream) => {
    // Replay buffer first so a new subscriber sees recent events.
    for (const item of eventBuffer) {
      await stream.writeSSE({ data: JSON.stringify(item.payload), event: item.type });
    }
    // Live subscription. Pump each event through writeSSE; remove on error.
    const writer = (item) => {
      stream.writeSSE({ data: JSON.stringify(item.payload), event: item.type }).catch(() => {
        eventSubscribers.delete(writer);
      });
    };
    eventSubscribers.add(writer);
    // Hold the connection open until the client disconnects (Hono closes the
    // generator on abort, which throws inside the await below).
    try {
      // Heartbeat every 15s keeps proxies (and any nginx between us and the
      // Blackhouse server) from idling out.
      for (;;) {
        await stream.sleep(15000);
        await stream.writeSSE({ data: "", event: "ping" });
      }
    } finally {
      eventSubscribers.delete(writer);
    }
  }),
);

// ---------- Health ------------------------------------------------------------

app.get("/browser/health", (c) =>
  c.json({
    ok: true,
    url: state.page.url(),
    streaming: "h264",
    codec: H264_CODEC_STRING,
    codedWidth: SCREENCAST_WIDTH,
    codedHeight: SCREENCAST_HEIGHT,
    peers: state.peers.size,
  }),
);

// ---------- State (strict e2e probe) -----------------------------------------
//
// Returns Chromium's actual page state queried via CDP `Runtime.evaluate`.
// Used by the strict e2e tests to assert that a gesture actually moved
// state (text was selected, page scrolled, contextmenu fired) — instead
// of only asserting that the right wire shape reached the input endpoint.
//
// `?resetContextMenu=1` clears `window.__lastCM` before reading so a test
// can synchronize "right click, then probe" without seeing stale data.

app.get("/browser/state", async (c) => {
  // Make sure the debug hook is installed (idempotent — installDebugHooks
  // guards with __bhDebugInstalled). Covers the case where the page has
  // never navigated since process start.
  try {
    await installDebugHooks(state.cdp);
  } catch {
    /* page not ready yet; reads below may still succeed */
  }

  const reset = c.req.query("resetContextMenu") === "1";

  let result;
  try {
    const evalResp = await state.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const reset = ${reset ? "true" : "false"};
        const cm = window.__lastCM || null;
        if (reset) window.__lastCM = null;
        let selectionText = "";
        try { selectionText = (window.getSelection()?.toString() || ""); } catch (e) {}
        return {
          url: location.href,
          title: document.title,
          selectionText,
          scrollY: window.scrollY,
          scrollX: window.scrollX,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          docSize: {
            width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
            height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
          },
          lastContextMenu: cm,
          activeElementTag: document.activeElement?.tagName || null,
        };
      })()`,
      returnByValue: true,
    });
    if (evalResp.exceptionDetails) {
      return c.json({ error: "eval_failed", details: evalResp.exceptionDetails }, 500);
    }
    result = evalResp.result?.value || {};
  } catch (err) {
    return c.json(
      { error: "cdp_error", message: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
  return c.json({ ok: true, ...result });
});

// ---------- Boot --------------------------------------------------------------

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`[browser-service] listening on http://${HOST}:${info.port}`);
});
injectWebSocket(server);

// Shut down cleanly on signals so dumb-init can reap us.
const shutdown = async (signal) => {
  console.log(`[browser-service] received ${signal}, closing`);
  try {
    await state.browser.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
