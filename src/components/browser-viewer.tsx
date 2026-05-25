import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, RefreshCw, ChevronDown, ChevronRight, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  decodeConfig,
  decodeConsoleEvent,
  decodeNavigateEvent,
  decodeVideoFrame,
  encodeInput,
  encodeRequest,
  PUSH_OP,
  REQUEST_OP,
  RESPONSE_OP,
  type InputMessage,
} from "@/lib/browser-input-codec";
import { createWsRpc, type WsRpc } from "@/lib/browser-ws-rpc";
// REST `/browser/state` is still alive on the server (selectionText /
// scrollX/Y / lastContextMenu — not yet projected through 0x84). The FE
// only uses it for the right-click "Copy" selectionText fetch; everything
// else is on the WS.
import { client } from "@/lib/api";
import { cn } from "@/lib/utils";

// Eval result payload returned by `agent/browser-service/service.mjs`'s
// runEval (#61). Permissive — only the fields the FE actually reads.
interface EvalResultPayload {
  ok: boolean;
  result?: string;
  error?: { description?: string; stack?: string };
}

interface BrowserViewerProps {
  sessionId: string;
  status: string;
  /**
   * When set, the embedded browser navigates to this URL on the next render
   * (or as soon as the session is running). Parent should clear it via
   * `onNavigated` to keep this prop a one-shot trigger — that way, clicking
   * the same URL twice in a row still re-fires the navigation.
   */
  navigateTo?: string | null;
  /** Called immediately after a `navigateTo` request has been dispatched. */
  onNavigated?: () => void;
}

interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  url?: string;
  line?: number;
  ts: number;
}

// Entries from the user-driven JS console eval input. `input` is echoed
// locally on submit; `result`/`error` arrive as the WS-RPC response (#61).
interface EvalEntry {
  kind: "input" | "result" | "error";
  text: string;
  ts: number;
}

type PanelEntry = (ConsoleEntry & { _t: "console" }) | (EvalEntry & { _t: "eval" });

type ControlAction = "navigate" | "back" | "forward" | "reload" | "resize";

// Viewport bounds for the dynamic-resize handshake with the server.
// H.264 requires even W/H; we round to even before sending.
const MIN_VIEWPORT_W = 320;
const MIN_VIEWPORT_H = 240;
const MAX_VIEWPORT_W = 1920;
const MAX_VIEWPORT_H = 1080;
const RESIZE_DEBOUNCE_MS = 250;

// Up-arrow history depth.
const EVAL_HISTORY_LIMIT = 50;

// CDP `Input.dispatchMouseEvent` expects a string button label.
function mouseButtonName(button: number): "left" | "middle" | "right" | "none" {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "none";
  }
}

// CDP `buttons` bitmask: 1=left, 2=right, 4=middle. Distinct from MouseEvent.button
// (which is an index). We track the OR of all currently-held buttons so mouseMove
// during a drag is dispatched as a drag (selection extension), not as a hover.
function bitFromMouseButton(button: number): number {
  switch (button) {
    case 0:
      return 1; // left
    case 1:
      return 4; // middle
    case 2:
      return 2; // right
    default:
      return 0;
  }
}

export function BrowserViewer({ sessionId, status, navigateTo, onNavigated }: BrowserViewerProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [pendingUrl, setPendingUrl] = useState("");
  const [connected, setConnected] = useState(false);
  // True once we've drawn at least one frame to the canvas — used to hide the
  // "Waiting for first frame…" overlay.
  const [hasFrame, setHasFrame] = useState(false);
  // Set if the browser lacks WebCodecs (Chromium 94+ / Firefox 130+ / Safari
  // 16.4+) or the decoder errors fatally. Rendered as an overlay placeholder.
  const [decoderError, setDecoderError] = useState<string | null>(() =>
    typeof window !== "undefined" && !("VideoDecoder" in window) ? t("browser.noWebCodecs") : null,
  );
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [panelEntries, setPanelEntries] = useState<PanelEntry[]>([]);
  const [evalInput, setEvalInput] = useState("");
  const [evalHistory, setEvalHistory] = useState<string[]>([]);
  const [evalHistoryIdx, setEvalHistoryIdx] = useState<number | null>(null);
  // Latest selection text from the in-container page, populated on context-menu
  // open via GET /browser/state. null = menu closed / not yet fetched.
  const [menuSelectionText, setMenuSelectionText] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // ResizeObserver watches the wrapper's bounding box to drive viewport sync.
  const frameWrapperRef = useRef<HTMLDivElement>(null);
  // Live screencast WS — kept in a ref so `sendInput` can write binary
  // input frames directly. Set on open, cleared on close. Reads check
  // `readyState === OPEN` before sending.
  const wsRef = useRef<WebSocket | null>(null);
  // Request/response RPC bound to the live WS (#61). Created in the
  // ws-effect alongside the WebSocket; disposed on cleanup so pending
  // requests reject with `ws_closed` instead of leaking timers.
  const rpcRef = useRef<WsRpc | null>(null);
  const mouseMoveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True between mousedown and mouseup. While true, mouseMove skips its 50ms
  // debounce — the agent-side selection highlight needs a continuous stream
  // of moves to render correctly via screencast frames.
  const isDraggingRef = useRef(false);
  // Window-level mouseup installed during drag so we still get the up event
  // when the user releases outside the frame.
  const windowMouseUpRef = useRef<((e: MouseEvent) => void) | null>(null);
  // CDP `buttons` bitmask — OR of all currently-pressed buttons. Sent with
  // every mouse input so the agent recognizes a mouseMove during a drag as a
  // selection extension rather than a hover.
  const buttonsRef = useRef(0);

  // ─── WebSocket frame stream (binary opcode protocol, #61) ──────────────
  // All frames are binary; the opcode byte at offset 0 routes the frame:
  //   0x80 config         → reconfigure VideoDecoder
  //   0x81 videoFrame     → decode key/delta chunk into the canvas
  //   0x82 (legacy ack)   → silently dropped (control is fire-and-forget)
  //   0x83 evalResult     → rpc.handleResponse → resolve pending eval
  //   0x84 stateSnapshot  → rpc.handleResponse → resolve pending state
  //   0x85 consoleEvent   → append to the console panel
  //   0x86 navigateEvent  → sync the address bar's url
  // The decoder is rebuilt on every 0x80 so a viewport resize (server
  // re-broadcasts 0x80 after the encoder restarts) switches codedWidth/
  // codedHeight cleanly.
  useEffect(() => {
    if (status !== "running") return;
    if (decoderError) return; // capability check failed — skip WS entirely

    let alive = true;
    let decoder: VideoDecoder | null = null;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const tokenMatch = document.cookie.match(/better-auth\.session_token=([^;]+)/);
    const tokenParam = tokenMatch ? `?token=${encodeURIComponent(tokenMatch[1])}` : "";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/browser-ws/${sessionId}${tokenParam}`,
    );
    ws.binaryType = "arraybuffer";

    const rpc = createWsRpc(ws);
    rpcRef.current = rpc;

    ws.onopen = () => {
      if (!alive) return;
      wsRef.current = ws;
      setConnected(true);
    };
    ws.onclose = () => {
      wsRef.current = null;
      if (alive) setConnected(false);
    };
    ws.onerror = () => {
      wsRef.current = null;
      if (alive) setConnected(false);
    };

    // Hoisted so the 0x80 handler can call it; re-runs after every resize
    // (server re-broadcasts 0x80 once the encoder restarts at new dims).
    function configureDecoder(codedWidth: number, codedHeight: number, codec: string) {
      // Tear down any previous decoder before configuring a new one.
      if (decoder) {
        try {
          decoder.close();
        } catch {
          /* already closed */
        }
        decoder = null;
      }
      const next = new VideoDecoder({
        output: (frame) => {
          const canvas = canvasRef.current;
          if (!alive || !canvas) {
            frame.close();
            return;
          }
          const ctx = canvas.getContext("2d", { alpha: false });
          if (!ctx) {
            frame.close();
            return;
          }
          // Use canvas's intrinsic size as the dest box; CSS `object-contain`
          // letterboxes the displayed surface to preserve aspect ratio.
          ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          // VideoFrames are GPU-backed and leak fast if not closed.
          frame.close();
          setHasFrame(true);
        },
        error: (err) => {
          console.error("[browser-viewer] VideoDecoder error", err);
          // Don't tear down — the next keyframe from the server will recover
          // the stream. Fatal errors will surface via decoder.state.
        },
      });
      try {
        next.configure({
          codec,
          codedWidth,
          codedHeight,
          // Interactive screencast: skip the decoder's reorder buffer and
          // surface frames as soon as they finish.
          optimizeForLatency: true,
          // GPU decode when available; falls back gracefully without H.264 HW.
          hardwareAcceleration: "prefer-hardware",
        });
      } catch (err) {
        console.error("[browser-viewer] VideoDecoder.configure failed", err);
        setDecoderError(
          `Decoder configure failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      // Sync canvas intrinsic dimensions so coord scaling and drawImage
      // both use the codec's pixel space.
      const canvas = canvasRef.current;
      if (canvas) {
        if (canvas.width !== codedWidth) canvas.width = codedWidth;
        if (canvas.height !== codedHeight) canvas.height = codedHeight;
      }
      decoder = next;
    }

    ws.onmessage = (event) => {
      if (!alive) return;

      // Single-transport wire — text frames are not part of the protocol
      // anymore (be #61: replaced by 0x80 binary config). Drop them.
      if (typeof event.data === "string") {
        console.warn("[browser-viewer] unexpected WS text frame; dropping");
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      if (event.data.byteLength < 1) return;

      // Opcode demux. Every frame after #61 starts with a 1-byte opcode.
      const opcode = new DataView(event.data).getUint8(0);
      switch (opcode) {
        case PUSH_OP.config: {
          const cfg = decodeConfig(event.data);
          if (!cfg) {
            console.warn("[browser-viewer] malformed 0x80 config frame");
            return;
          }
          configureDecoder(cfg.codedWidth, cfg.codedHeight, cfg.codec);
          return;
        }
        case PUSH_OP.videoFrame: {
          if (!decoder) return; // chunks arriving before config — drop; next keyframe recovers
          const vf = decodeVideoFrame(event.data);
          if (!vf) return;
          try {
            decoder.decode(
              new EncodedVideoChunk({
                type: vf.isKey ? "key" : "delta",
                // EncodedVideoChunk wants a Number, not bigint — codec pts are
                // microseconds since stream start and easily fit in 53 bits.
                timestamp: Number(vf.pts),
                // Copy the view's underlying bytes into a fresh ArrayBuffer
                // so the next message's bytes don't trample the in-flight chunk.
                data: vf.nalu.slice(),
              }),
            );
          } catch (err) {
            console.warn("[browser-viewer] decode() threw", err);
          }
          return;
        }
        case 0x82:
          // Legacy CONTROL_ACK — silently dropped (control is fire-and-forget
          // now). Server may still emit briefly during be's BE-cut2 transition.
          return;
        case RESPONSE_OP.evalResult:
        case RESPONSE_OP.stateSnapshot:
          rpc.handleResponse(event.data);
          return;
        case PUSH_OP.consoleEvent: {
          const ev = decodeConsoleEvent(event.data);
          if (!ev) return;
          // Map be's `kind` string to the ConsoleEntry `level` union.
          const level = (
            ["log", "info", "warn", "error", "debug"].includes(ev.kind) ? ev.kind : "log"
          ) as ConsoleEntry["level"];
          setPanelEntries((prev) => [
            ...prev.slice(-499),
            {
              _t: "console",
              level,
              text: ev.text,
              url: ev.url || undefined,
              line: ev.line || undefined,
              ts: ev.ts,
            },
          ]);
          return;
        }
        case PUSH_OP.navigateEvent: {
          const ev = decodeNavigateEvent(event.data);
          if (!ev || !ev.url) return;
          setUrl(ev.url);
          setPendingUrl(ev.url);
          return;
        }
        default:
          console.warn(`[browser-viewer] unknown WS opcode 0x${opcode.toString(16)}`);
      }
    };

    return () => {
      alive = false;
      rpc.dispose("ws_unmount");
      rpcRef.current = null;
      wsRef.current = null;
      ws.close();
      if (decoder) {
        try {
          decoder.close();
        } catch {
          /* already closed */
        }
        decoder = null;
      }
      // If the user unmounts mid-drag, drop the window-level mouseup listener
      // so it doesn't leak (or fire against a stale closure). Also clear the
      // pending mouseMove debounce timer for the same reason.
      if (windowMouseUpRef.current) {
        window.removeEventListener("mouseup", windowMouseUpRef.current);
        windowMouseUpRef.current = null;
      }
      if (mouseMoveTimerRef.current) {
        clearTimeout(mouseMoveTimerRef.current);
        mouseMoveTimerRef.current = null;
      }
      isDraggingRef.current = false;
      setHasFrame(false);
    };
  }, [sessionId, status, decoderError]);

  // Console + navigate events are now delivered as 0x85 / 0x86 push frames
  // over the same screencast WS — handled in the opcode demux above. No
  // more SSE EventSource. (REST /browser/console SSE is still live on the
  // server for backward compat; the FE just stops listening.)

  // ─── Control + Input via WS (#61) ──────────────────────────────────────
  // Control is fire-and-forget: we send 0x10 with reqId=0 and never await
  // a response. Implicit ack arrives as a 0x80 (after resize re-encodes)
  // or 0x86 navigate event (after nav/back/forward/reload). Saves a
  // pending-map entry + timeout per call — matters for resize which fires
  // constantly during window-drag.
  const sendControl = useCallback((action: Exclude<ControlAction, "resize">, navUrl?: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeRequest(REQUEST_OP.control, 0, { action, url: navUrl }));
  }, []);

  // Drop input frames once the WS send buffer climbs over this — a stale
  // mouseMove arriving 3s late is worse than no event. Generous enough to
  // absorb a normal scroll burst (~100B per event × ~600 events).
  const WS_INPUT_BACKPRESSURE_LIMIT = 64 * 1024;

  // Single transport: binary frame over the live screencast WS, encoded
  // per `browser-input-codec.ts`. If the WS isn't ready or the send buffer
  // is over budget, we drop — fire-and-forget semantics, no REST fallback.
  // `InputMessage` is a discriminated union so `encodeInput` is statically
  // exhaustive; adding a new event type is a tsc error until both sides
  // catch up.
  const sendInput = useCallback((body: InputMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount >= WS_INPUT_BACKPRESSURE_LIMIT) return;
    ws.send(encodeInput(body));
  }, []);

  // ─── Dynamic viewport: request server to re-encode at new size ─────────
  // Fire-and-forget like sendControl. The server re-broadcasts a 0x80
  // config frame once the encoder restarts; our binary opcode-demux
  // handler tears down the old VideoDecoder and configures a new one
  // with the new dims.
  const sendResize = useCallback((width: number, height: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeRequest(REQUEST_OP.control, 0, { action: "resize", width, height }));
  }, []);

  // Watch the visible frame wrapper. On size change, debounce 250ms then POST
  // a resize control with even-rounded, clamped (320..1920 × 240..1080) dims.
  useEffect(() => {
    if (status !== "running") return;
    if (decoderError) return;
    const el = frameWrapperRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const cr = entry.contentRect;
      // Round to even (H.264 requirement), then clamp to viewport bounds.
      const width = Math.max(
        MIN_VIEWPORT_W,
        Math.min(MAX_VIEWPORT_W, Math.round(cr.width / 2) * 2),
      );
      const height = Math.max(
        MIN_VIEWPORT_H,
        Math.min(MAX_VIEWPORT_H, Math.round(cr.height / 2) * 2),
      );
      if (width <= 0 || height <= 0) return;

      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        // Idempotency: skip if the live stream is already at these dims.
        // After be re-broadcasts the post-resize `config`, our WS handler
        // syncs `canvas.width`/`.height` — so this check uses ground truth.
        const canvas = canvasRef.current;
        if (canvas && canvas.width === width && canvas.height === height) return;
        sendResize(width, height);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
    };
  }, [status, decoderError, sendResize]);

  // ─── Coordinate scaling ─────────────────────────────────────────────────
  // The canvas's intrinsic width/height match the codec's pixel space (set
  // by the WS config message), so we use those as the target dimensions.
  // CSS `object-contain` letterboxes the displayed surface; the simple
  // ratio math here is slightly off in the letterbox region, but accurate
  // enough for click/select gestures on the displayed content area.
  const toScreencastCoords = useCallback((clientX: number, clientY: number) => {
    const el = canvasRef.current;
    if (!el || !el.width || !el.height) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(((clientX - rect.left) / rect.width) * el.width),
      y: Math.round(((clientY - rect.top) / rect.height) * el.height),
    };
  }, []);

  // ─── Input handlers ─────────────────────────────────────────────────────
  const handleMouseMove = (e: React.MouseEvent) => {
    const { x, y } = toScreencastCoords(e.clientX, e.clientY);
    // While dragging (mousedown→mouseup), skip the 50ms debounce so the agent
    // receives every move. This is what makes text-selection drag render
    // correctly via screencast frames.
    if (isDraggingRef.current) {
      if (mouseMoveTimerRef.current) clearTimeout(mouseMoveTimerRef.current);
      sendInput({ type: "mouseMove", x, y, buttons: buttonsRef.current });
      return;
    }
    if (mouseMoveTimerRef.current) clearTimeout(mouseMoveTimerRef.current);
    mouseMoveTimerRef.current = setTimeout(() => {
      sendInput({ type: "mouseMove", x, y, buttons: buttonsRef.current });
    }, 50);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    // Right-click (button 2) is owned by the SPA ContextMenu, not
    // forwarded to the in-container CDP. If a page has its own custom
    // contextmenu handler (Google Maps, etc.) it won't fire — accepted
    // tradeoff; the SPA menu is what users expect.
    if (e.button === 2) return;
    const { x, y } = toScreencastCoords(e.clientX, e.clientY);
    const button = mouseButtonName(e.button);
    const bit = bitFromMouseButton(e.button);
    buttonsRef.current |= bit;
    sendInput({
      type: "mouseDown",
      x,
      y,
      button,
      clickCount: 1,
      buttons: buttonsRef.current,
    });
    isDraggingRef.current = true;

    // Install a window-level mouseup listener so we still get the up event
    // when the user releases outside the frame. Chromium synthesizes its own
    // `contextmenu` event from the right-click sequence — we deliberately do
    // NOT send a separate contextmenu input.
    if (windowMouseUpRef.current) {
      window.removeEventListener("mouseup", windowMouseUpRef.current);
    }
    const onUp = (we: MouseEvent) => {
      const upCoords = toScreencastCoords(we.clientX, we.clientY);
      buttonsRef.current &= ~bit;
      sendInput({
        type: "mouseUp",
        x: upCoords.x,
        y: upCoords.y,
        button,
        clickCount: 1,
        buttons: buttonsRef.current,
      });
      isDraggingRef.current = false;
      window.removeEventListener("mouseup", onUp);
      windowMouseUpRef.current = null;
    };
    windowMouseUpRef.current = onUp;
    window.addEventListener("mouseup", onUp);
  };

  // Right-click → SPA-rendered ContextMenu (see #47). Fetches live page
  // selectionText on open so the "Copy" item can conditionally appear.
  //
  // selectionText isn't in the 0x12/0x84 state response shape (be's
  // runWsState only projects url/title/loading). The legacy REST
  // /browser/state endpoint is unchanged and still emits selectionText —
  // we keep using that until qa migrates the e2e probe.
  const onContextMenuOpenChange = useCallback(
    async (open: boolean) => {
      if (!open) {
        setMenuSelectionText(null);
        return;
      }
      try {
        const res = await client.api.sessions[":id"].browser.state.$get({
          param: { id: sessionId },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { selectionText?: string };
        setMenuSelectionText(typeof data.selectionText === "string" ? data.selectionText : "");
      } catch {
        // browser unavailable / network error — Copy will stay hidden
      }
    },
    [sessionId],
  );

  const clipboardAvailable =
    typeof navigator !== "undefined" &&
    !!navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function";

  const onOpenInRealBrowser = () => {
    const target = url || pendingUrl;
    if (!target) return;
    window.open(target, "_blank", "noopener,noreferrer");
  };

  const onViewSource = () => {
    const target = url || pendingUrl;
    if (!target) return;
    window.open(`view-source:${target}`, "_blank", "noopener,noreferrer");
  };

  const onCopySelection = async () => {
    if (!menuSelectionText || !clipboardAvailable) return;
    try {
      await navigator.clipboard.writeText(menuSelectionText);
    } catch {
      // permission denied or insecure context — silently swallow
    }
  };

  // Wheel handler is installed as a NATIVE (non-passive) listener via the
  // useEffect below, NOT as a React onWheel prop. React's onWheel registers
  // a passive listener (can't preventDefault), so the SPA itself would scroll
  // alongside the in-container browser. Native listener gets RAF batching too.
  useEffect(() => {
    if (status !== "running") return;
    const el = canvasRef.current;
    if (!el) return;

    // Accumulate wheel deltas within a single animation frame so we send at
    // most one wheel input per frame, regardless of trackpad/mouse-wheel rate.
    let dx = 0;
    let dy = 0;
    let lastX = 0;
    let lastY = 0;
    let rafId = 0;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // SPA must NOT scroll; only the embedded page does
      const { x, y } = toScreencastCoords(e.clientX, e.clientY);
      dx += e.deltaX;
      dy += e.deltaY;
      lastX = x;
      lastY = y;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        sendInput({
          type: "wheel",
          x: lastX,
          y: lastY,
          deltaX: dx,
          deltaY: dy,
          buttons: buttonsRef.current,
        });
        dx = 0;
        dy = 0;
        rafId = 0;
      });
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      el.removeEventListener("wheel", onWheel);
    };
  }, [status, sendInput, toScreencastCoords]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    sendInput({ type: "keyDown", key: e.key, code: e.code });
    // CDP needs a separate 'char' event for printable text so IME works
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      sendInput({ type: "char", text: e.key });
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent) => {
    sendInput({ type: "keyUp", key: e.key, code: e.code });
  };

  // ─── Navigation actions ─────────────────────────────────────────────────
  const navigate = useCallback(
    (target: string) => {
      const normalized =
        target.startsWith("http://") || target.startsWith("https://")
          ? target
          : `https://${target}`;
      setUrl(normalized);
      setPendingUrl(normalized);
      sendControl("navigate", normalized);
    },
    [sendControl],
  );

  const reload = () => {
    sendControl("reload");
  };

  // External one-shot navigation trigger (e.g. terminal link click → #46).
  // Parent clears `navigateTo` via `onNavigated` so the next set fires again
  // even if the same URL is clicked twice in a row.
  useEffect(() => {
    if (!navigateTo) return;
    if (status !== "running") return;
    navigate(navigateTo);
    onNavigated?.();
  }, [navigateTo, status, navigate, onNavigated]);

  // ─── JS console eval ────────────────────────────────────────────────────
  // Result/error come back as the resolution of the WS-RPC promise (#61).
  // No SSE eval listener anymore — single source of truth.
  const submitEval = useCallback(async () => {
    const expression = evalInput.trim();
    if (!expression) return;
    // Optimistic local echo of the input.
    const ts = Date.now();
    setPanelEntries((prev) => [
      ...prev.slice(-499),
      { _t: "eval", kind: "input", text: expression, ts },
    ]);
    setEvalHistory((prev) => [...prev.slice(-(EVAL_HISTORY_LIMIT - 1)), expression]);
    setEvalHistoryIdx(null);
    setEvalInput("");

    const rpc = rpcRef.current;
    if (!rpc) {
      setPanelEntries((prev) => [
        ...prev.slice(-499),
        { _t: "eval", kind: "error", text: "ws not connected", ts: Date.now() },
      ]);
      return;
    }
    try {
      // eval may take longer than the default 5s timeout for expensive
      // expressions — bump to 30s, matching the in-container CDP timeout.
      const data = await rpc.request<EvalResultPayload>(REQUEST_OP.eval, { expression }, 30_000);
      if (data.ok) {
        setPanelEntries((prev) => [
          ...prev.slice(-499),
          { _t: "eval", kind: "result", text: data.result ?? "", ts: Date.now() },
        ]);
      } else {
        setPanelEntries((prev) => [
          ...prev.slice(-499),
          {
            _t: "eval",
            kind: "error",
            text: data.error?.description ?? "eval failed",
            ts: Date.now(),
          },
        ]);
      }
    } catch (err) {
      setPanelEntries((prev) => [
        ...prev.slice(-499),
        {
          _t: "eval",
          kind: "error",
          text: err instanceof Error ? err.message : "eval request failed",
          ts: Date.now(),
        },
      ]);
    }
  }, [evalInput]);

  const handleEvalKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitEval();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (evalHistory.length === 0) return;
      const next =
        evalHistoryIdx === null ? evalHistory.length - 1 : Math.max(0, evalHistoryIdx - 1);
      setEvalHistoryIdx(next);
      setEvalInput(evalHistory[next]);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (evalHistoryIdx === null) return;
      const next = evalHistoryIdx + 1;
      if (next >= evalHistory.length) {
        setEvalHistoryIdx(null);
        setEvalInput("");
      } else {
        setEvalHistoryIdx(next);
        setEvalInput(evalHistory[next]);
      }
      return;
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────
  if (status !== "running") {
    return (
      <div className="flex h-full items-center justify-center bg-muted text-xs text-muted-foreground">
        {t("browser.notRunning", { status })}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Address bar */}
      <form
        className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (pendingUrl.trim()) navigate(pendingUrl.trim());
        }}
      >
        <Globe className="size-3 shrink-0 text-muted-foreground" />
        <Input
          value={pendingUrl}
          onChange={(e) => setPendingUrl(e.target.value)}
          placeholder={t("browser.urlPlaceholder")}
          className="h-6 flex-1 font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
        <Button type="submit" variant="outline" size="icon-sm" aria-label={t("browser.go")}>
          <ArrowRight className="size-3" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={reload}
          aria-label={t("browser.reload")}
        >
          <RefreshCw className="size-3" />
        </Button>
      </form>

      {/* Frame area — WebCodecs VideoDecoder draws H.264 frames here.
          `data-browser-frame` is qa's stable e2e selector. Initial intrinsic
          dims (1280x720) are overwritten by the WS config message; the
          ResizeObserver on this wrapper drives the dynamic-resize handshake
          so the in-container browser viewport matches the panel. */}
      <div
        ref={frameWrapperRef}
        className="relative flex-1 min-h-0 overflow-hidden bg-black"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
      >
        <ContextMenu onOpenChange={onContextMenuOpenChange}>
          <ContextMenuTrigger
            render={
              <canvas
                ref={canvasRef}
                data-browser-frame
                width={1280}
                height={720}
                draggable={false}
                className="block h-full w-full select-none bg-black object-contain"
                onMouseMove={handleMouseMove}
                onMouseDown={handleMouseDown}
              />
            }
          />
          <ContextMenuContent className="min-w-48">
            <ContextMenuItem onClick={() => sendControl("back")}>
              {t("browser.menu.back")}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => sendControl("forward")}>
              {t("browser.menu.forward")}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => sendControl("reload")}>
              {t("browser.menu.reload")}
            </ContextMenuItem>
            {clipboardAvailable && menuSelectionText && menuSelectionText.length > 0 && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={onCopySelection}>
                  {t("browser.menu.copy")}
                </ContextMenuItem>
              </>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onOpenInRealBrowser}>
              {t("browser.menu.openInNewTab")}
            </ContextMenuItem>
            <ContextMenuItem onClick={onViewSource}>
              {t("browser.menu.viewPageSource")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {!hasFrame && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            {decoderError
              ? decoderError
              : connected
                ? t("browser.waitingForFrame")
                : url
                  ? t("browser.disconnected")
                  : t("browser.enterUrl")}
          </div>
        )}
      </div>

      {/* Console panel */}
      <Collapsible
        open={consoleOpen}
        onOpenChange={setConsoleOpen}
        className="shrink-0 border-t border-border"
      >
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className="flex w-full items-center gap-1 px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50"
            />
          }
        >
          {consoleOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <span className="font-medium">{t("browser.consoleHeading")}</span>
          {panelEntries.length > 0 && (
            <span className="ml-1 text-muted-foreground/70">({panelEntries.length})</span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ScrollArea className="h-32">
            <div className="px-2 py-1 font-mono text-xs">
              {panelEntries.length === 0 ? (
                <div className="py-2 text-muted-foreground">{t("browser.noConsoleOutput")}</div>
              ) : (
                panelEntries.map((entry, i) =>
                  entry._t === "console" ? (
                    <div
                      key={i}
                      className={cn(
                        "border-b border-border/40 py-0.5 last:border-b-0",
                        entry.level === "error" && "text-red-500",
                        entry.level === "warn" && "text-yellow-500",
                        entry.level === "debug" && "text-muted-foreground",
                      )}
                    >
                      <span className="text-muted-foreground/60">[{entry.level}]</span> {entry.text}
                      {entry.url && (
                        <span className="ml-2 text-muted-foreground/60">
                          {entry.url}
                          {entry.line ? `:${entry.line}` : ""}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div
                      key={i}
                      className={cn(
                        "border-b border-border/40 py-0.5 last:border-b-0",
                        entry.kind === "input" && "text-muted-foreground",
                        entry.kind === "error" && "text-red-500",
                      )}
                    >
                      <span className="text-muted-foreground/60">
                        {entry.kind === "input" ? ">" : entry.kind === "error" ? "✗" : "←"}
                      </span>{" "}
                      <span className={entry.kind === "input" ? "" : "whitespace-pre-wrap"}>
                        {entry.text}
                      </span>
                    </div>
                  ),
                )
              )}
            </div>
          </ScrollArea>
          <div className="flex items-center gap-1 border-t border-border px-2 py-1">
            <span className="text-muted-foreground/60 font-mono text-xs">{">"}</span>
            <Input
              value={evalInput}
              onChange={(e) => setEvalInput(e.target.value)}
              onKeyDown={handleEvalKeyDown}
              placeholder={connected ? t("browser.evalPlaceholder") : t("browser.evalDisconnected")}
              disabled={!connected}
              spellCheck={false}
              autoComplete="off"
              className="h-6 flex-1 font-mono text-xs"
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
