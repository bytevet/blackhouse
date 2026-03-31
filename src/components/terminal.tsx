import { useEffect, useRef, useCallback, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

interface TerminalPanelProps {
  sessionId: string;
  status: string;
}

// Resize message prefix byte (0x01) — distinguishes from terminal input
const RESIZE_PREFIX = 0x01;

function RunningCat() {
  return <img src="/nyancat.svg" alt="" className="h-4" draggable={false} />;
}

function encodeResize(cols: number, rows: number): ArrayBuffer {
  const payload = `${cols}:${rows}`;
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = RESIZE_PREFIX;
  for (let i = 0; i < payload.length; i++) buf[i + 1] = payload.charCodeAt(i);
  return buf.buffer as ArrayBuffer;
}

export function TerminalPanel({ sessionId, status }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [connected, setConnected] = useState(false);
  const [focused, setFocused] = useState(false);

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
      `${protocol}//${window.location.host}/api/terminal/${sessionId}${tokenParam}`,
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
        }
        // 0x02 = system info — ignore
        // Other types — ignore
      } else {
        // Plain text fallback
        terminal.write(event.data);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      terminalRef.current?.write("\r\n\x1b[33m[Connection closed]\x1b[0m\r\n");
    };

    ws.onerror = () => {
      setConnected(false);
      terminalRef.current?.write("\r\n\x1b[31m[Connection error]\x1b[0m\r\n");
    };
  }, [sessionId, status, sendResize]);

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

      const termBg =
        getComputedStyle(containerRef.current).getPropertyValue("--color-terminal").trim() ||
        "#0a0a0a";

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
      terminal.loadAddon(new WebLinksAddon());
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
      terminal?.dispose();
    };
  }, [connect, sendResize]);

  if (status !== "running") {
    return (
      <div className="flex h-full items-center justify-center bg-terminal text-sm text-muted-foreground">
        Session is {status}. Start the session to access the terminal.
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-terminal">
      <div ref={containerRef} className="absolute inset-0 bottom-6" />
      <div
        className="absolute inset-x-0 bottom-0 flex h-6 items-center justify-between border-t border-white/10 px-2 font-mono text-xs"
        onClick={() => terminalRef.current?.focus()}
      >
        <span className="flex items-center gap-1.5">
          <span className={`size-1.5 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
          <span className="text-muted-foreground">{connected ? "Connected" : "Disconnected"}</span>
        </span>
        {focused ? (
          <RunningCat />
        ) : (
          <span className="text-muted-foreground/50">Click to focus</span>
        )}
      </div>
    </div>
  );
}
