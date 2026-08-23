import { useEffect, useRef, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { AgentStatus } from "@/db/schema";

interface TerminalPanelProps {
  agentId: string;
  status: AgentStatus;
  /**
   * Called when the user clicks a URL in terminal output. If provided, the
   * default xterm WebLinks behavior (`window.open` in a new tab) is bypassed
   * — caller is fully responsible for handling the URL (e.g. routing it to
   * the embedded browser). If omitted, the default new-tab behavior is used.
   */
  onLinkClick?: (url: string) => void;
}

// Resize message prefix byte (0x01) — distinguishes from terminal input
const RESIZE_PREFIX = 0x01;
// System notice (0x02) — JSON payload, server → client only. Today it carries
// the injection lifecycle so the UI can say "someone else is typing into this".
const SYSTEM_PREFIX = 0x02;

function RunningCat() {
  return <img src="/nyancat.svg" alt="" style={{ height: 16 }} draggable={false} />;
}

function encodeResize(cols: number, rows: number): ArrayBuffer {
  const payload = `${cols}:${rows}`;
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = RESIZE_PREFIX;
  for (let i = 0; i < payload.length; i++) buf[i + 1] = payload.charCodeAt(i);
  return buf.buffer as ArrayBuffer;
}

export function TerminalPanel({ agentId, status, onLinkClick }: TerminalPanelProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror the latest `onLinkClick` into a ref so the WebLinksAddon callback
  // — set once at terminal init — sees prop changes without tearing down xterm.
  const onLinkClickRef = useRef(onLinkClick);
  onLinkClickRef.current = onLinkClick;
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [connected, setConnected] = useState(false);
  const [focused, setFocused] = useState(false);
  // The harness writes injected prompts into the same stdin the user types on.
  // Without this banner a multi-KB paste appearing under your cursor is
  // indistinguishable from the agent having gone haywire.
  const [injecting, setInjecting] = useState(false);

  const sendResize = useCallback((cols: number, rows: number, immediate = false) => {
    if (immediate) {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(encodeResize(cols, rows));
      }
      return;
    }
    // Debounce: only send the last resize after 50ms of no changes
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(encodeResize(cols, rows));
      }
    }, 50);
  }, []);

  const connect = useCallback(() => {
    if (status !== "running") return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const tokenMatch = document.cookie.match(/better-auth\.session_token=([^;]+)/);
    const tokenParam = tokenMatch ? `?token=${encodeURIComponent(tokenMatch[1])}` : "";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/terminal/${agentId}${tokenParam}`,
    );
    wsRef.current = ws;

    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      setConnected(true);
      terminalRef.current?.focus();
      // Send resize immediately (no debounce) so the container PTY
      // knows the correct dimensions before any output is rendered
      const fitAddon = fitAddonRef.current;
      if (fitAddon) {
        fitAddon.fit();
        const dims = fitAddon.proposeDimensions();
        if (dims) {
          sendResize(dims.cols, dims.rows, true);
        }
      }
    };

    ws.onmessage = (event) => {
      const terminal = terminalRef.current;
      if (!terminal) return;

      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        if (bytes.length === 0) return;
        const type = bytes[0];
        const payload = bytes.subarray(1);
        if (type === 0x00) {
          terminal.write(payload);
        } else if (type === SYSTEM_PREFIX) {
          // `{ event: "inject_start" | "inject_end", ... }`. Unknown events are
          // ignored rather than surfaced — the server is free to add more.
          try {
            const notice = JSON.parse(new TextDecoder().decode(payload)) as { event?: string };
            if (notice.event === "inject_start") setInjecting(true);
            else if (notice.event === "inject_end") setInjecting(false);
          } catch {
            // Malformed notice — the terminal itself is unaffected, so drop it.
          }
        }
        // Other types — ignore
      } else {
        // Plain text fallback
        terminal.write(event.data);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setInjecting(false);
      terminalRef.current?.write("\r\n\x1b[33m[Connection closed]\x1b[0m\r\n");
    };

    ws.onerror = () => {
      setConnected(false);
      setInjecting(false);
      terminalRef.current?.write("\r\n\x1b[31m[Connection error]\x1b[0m\r\n");
    };
  }, [agentId, status, sendResize]);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let terminal: InstanceType<typeof import("@xterm/xterm").Terminal> | null = null;

    (async () => {
      const [
        { Terminal },
        { FitAddon },
        { WebLinksAddon },
        { Unicode11Addon },
        { WebglAddon },
        { ImageAddon },
        { ClipboardAddon },
        { SearchAddon },
      ] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-unicode11"),
        import("@xterm/addon-webgl"),
        import("@xterm/addon-image"),
        import("@xterm/addon-clipboard"),
        import("@xterm/addon-search"),
      ]);
      await import("@xterm/xterm/css/xterm.css");

      if (disposed || !containerRef.current) return;

      // `--ny-ink-0` is theme-invariant: a light xterm is not a thing anyone
      // wants, so the terminal stays dark in both themes.
      const termBg =
        getComputedStyle(containerRef.current).getPropertyValue("--ny-ink-0").trim() || "#0a0a0a";

      terminal = new Terminal({
        fontFamily: "'Source Code Pro Variable', 'Source Code Pro', monospace",
        fontSize: 14,
        lineHeight: 1.15,
        cursorBlink: true,
        cursorStyle: "bar",
        allowProposedApi: true,
        scrollback: 50000,
        drawBoldTextInBrightColors: true,
        minimumContrastRatio: 4.5,
        macOptionIsMeta: true,
        macOptionClickForcesSelection: true,
        rightClickSelectsWord: true,
        theme: {
          background: termBg,
          foreground: "#d4d4d8",
          cursor: "#d4d4d8",
          cursorAccent: "#0a0a0a",
          selectionBackground: "#3f3f46",
          selectionForeground: "#fafafa",
          black: "#18181b",
          red: "#ef4444",
          green: "#22c55e",
          yellow: "#eab308",
          blue: "#3b82f6",
          magenta: "#a855f7",
          cyan: "#06b6d4",
          white: "#d4d4d8",
          brightBlack: "#52525b",
          brightRed: "#f87171",
          brightGreen: "#4ade80",
          brightYellow: "#facc15",
          brightBlue: "#60a5fa",
          brightMagenta: "#c084fc",
          brightCyan: "#22d3ee",
          brightWhite: "#fafafa",
        },
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(
        new WebLinksAddon((event, uri) => {
          const handler = onLinkClickRef.current;
          if (handler) {
            event.preventDefault();
            handler(uri);
          } else {
            window.open(uri, "_blank", "noopener,noreferrer");
          }
        }),
      );
      terminal.loadAddon(new Unicode11Addon());
      terminal.loadAddon(new ClipboardAddon());
      terminal.loadAddon(new ImageAddon());
      terminal.loadAddon(new SearchAddon());
      terminal.unicode.activeVersion = "11";
      terminal.open(containerRef.current);

      // GPU-accelerated rendering with canvas fallback
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        terminal.loadAddon(webgl);
      } catch {
        // WebGL not available — falls back to canvas renderer
      }

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      fitAddon.fit();

      const textarea = terminal.textarea;
      if (textarea) {
        textarea.addEventListener("focus", () => setFocused(true));
        textarea.addEventListener("blur", () => setFocused(false));
      }

      terminal.focus();

      // Terminal input → WebSocket (binary frame with 0x00 prefix)
      // Filter out terminal query sequences (DA, DSR, cursor position) that
      // xterm.js auto-sends — these get echoed as literal text by the shell
      const TERM_QUERY = /\x1b\[[\d;]*c|\x1b\[\?[\d;]*c|\x1b\[[\d;]*n|\x1b\[[\d;]*R/;
      terminal.onData((data) => {
        if (TERM_QUERY.test(data)) return;
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          const encoded = new TextEncoder().encode(data);
          const frame = new Uint8Array(1 + encoded.length);
          frame[0] = 0x00;
          frame.set(encoded, 1);
          ws.send(frame);
        }
      });

      // Terminal resize → WebSocket (binary frames with prefix byte)
      terminal.onResize(({ cols, rows }) => {
        sendResize(cols, rows);
      });

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
      });
      resizeObserver.observe(containerRef.current!);
      resizeObserverRef.current = resizeObserver;

      connect();
    })();

    return () => {
      disposed = true;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeObserverRef.current?.disconnect();
      wsRef.current?.close();
      wsRef.current = null;
      setConnected(false);
      setFocused(false);
      setInjecting(false);
      terminal?.dispose();
    };
  }, [connect, sendResize]);

  if (status !== "running") {
    return (
      <div
        style={{
          height: "100%",
          display: "grid",
          placeItems: "center",
          background: "var(--ny-ink-0)",
          color: "var(--ny-ink-6)",
          fontFamily: "var(--ny-font-mono)",
          fontSize: 12,
        }}
      >
        {t("terminal.notRunning", { status })}
      </div>
    );
  }

  return (
    <div
      style={{ position: "relative", height: "100%", width: "100%", background: "var(--ny-ink-0)" }}
    >
      <div ref={containerRef} style={{ position: "absolute", inset: 0, bottom: 24 }} />

      {injecting && (
        <div
          role="status"
          style={{
            position: "absolute",
            top: 8,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 11px",
            borderRadius: 999,
            border: "1px solid var(--ny-info-border)",
            background: "var(--ny-info-subtle)",
            color: "var(--ny-info-text)",
            fontFamily: "var(--ny-font-mono)",
            fontSize: 11,
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--ny-info)",
              animation: "nyPulse 1.1s ease-in-out infinite",
            }}
          />
          {t("terminal.injecting")}
        </div>
      )}

      <div
        onClick={() => terminalRef.current?.focus()}
        style={{
          position: "absolute",
          insetInline: 0,
          bottom: 0,
          height: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 8px",
          borderTop: "1px solid rgb(255 255 255 / 0.1)",
          fontFamily: "var(--ny-font-mono)",
          fontSize: 11,
          color: "var(--ny-ink-6)",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: connected ? "var(--ny-success)" : "var(--ny-danger)",
            }}
          />
          {connected ? t("terminal.connected") : t("terminal.disconnected")}
        </span>
        {focused ? <RunningCat /> : <span>{t("terminal.clickToFocus")}</span>}
      </div>
    </div>
  );
}
