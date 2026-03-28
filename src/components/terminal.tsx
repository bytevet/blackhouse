import { useEffect, useRef, useCallback, useState } from "react";

interface TerminalPanelProps {
  sessionId: string;
  status: string;
}

// Resize message prefix byte (0x01) — distinguishes from terminal input
const RESIZE_PREFIX = 0x01;

function encodeResize(cols: number, rows: number): Uint8Array {
  const payload = `${cols}:${rows}`;
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = RESIZE_PREFIX;
  for (let i = 0; i < payload.length; i++) buf[i + 1] = payload.charCodeAt(i);
  return buf;
}

export function TerminalPanel({ sessionId, status }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendResize = useCallback((cols: number, rows: number) => {
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
      const fitAddon = fitAddonRef.current;
      if (fitAddon) {
        const dims = fitAddon.proposeDimensions();
        if (dims) {
          sendResize(dims.cols, dims.rows);
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
          // Terminal data
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
      terminalRef.current?.write("\r\n\x1b[33m[Connection closed]\x1b[0m\r\n");
    };

    ws.onerror = () => {
      terminalRef.current?.write("\r\n\x1b[31m[Connection error]\x1b[0m\r\n");
    };
  }, [sessionId, status, sendResize]);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let terminal: InstanceType<typeof import("@xterm/xterm").Terminal> | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { Unicode11Addon }] = await Promise.all(
        [
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-web-links"),
          import("@xterm/addon-unicode11"),
        ],
      );
      await import("@xterm/xterm/css/xterm.css");

      if (disposed || !containerRef.current) return;

      terminal = new Terminal({
        fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', monospace",
        fontSize: 13,
        lineHeight: 1.0,
        letterSpacing: 0,
        cursorBlink: true,
        cursorStyle: "bar",
        allowProposedApi: true,
        scrollback: 10000,
        theme: {
          background: "#0a0a0a",
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
      const webLinksAddon = new WebLinksAddon();
      const unicode11Addon = new Unicode11Addon();

      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.loadAddon(unicode11Addon);
      terminal.unicode.activeVersion = "11";
      terminal.open(containerRef.current);

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      fitAddon.fit();

      // Terminal input → WebSocket (binary frame with 0x00 prefix)
      terminal.onData((data) => {
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

      connect();

      return () => {
        resizeObserver.disconnect();
        terminal?.dispose();
      };
    })();

    return () => {
      disposed = true;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      wsRef.current?.close();
      terminal?.dispose();
    };
  }, [connect, sendResize]);

  if (status !== "running") {
    return (
      <div className="flex h-full items-center justify-center bg-[#0a0a0a] text-sm text-muted-foreground">
        Session is {status}. Start the session to access the terminal.
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full bg-[#0a0a0a]" />;
}
