import { useEffect, useRef, useCallback, useState } from "react";

interface TerminalPanelProps {
  sessionId: string;
  status: string;
}

export function TerminalPanel({ sessionId, status }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const connect = useCallback(() => {
    if (status !== "running") return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    // Extract auth token from cookies for WebSocket auth
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
          ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
        }
      }
    };

    ws.onmessage = (event) => {
      const terminal = terminalRef.current;
      if (!terminal) return;

      if (event.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(event.data));
      } else {
        terminal.write(event.data);
      }
    };

    ws.onclose = () => {
      terminalRef.current?.write("\r\n\x1b[33m[Connection closed]\x1b[0m\r\n");
    };

    ws.onerror = () => {
      terminalRef.current?.write("\r\n\x1b[31m[Connection error]\x1b[0m\r\n");
    };
  }, [sessionId, status]);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let terminal: InstanceType<typeof import("@xterm/xterm").Terminal> | null = null;

    (async () => {
      // Dynamic import to avoid SSR issues (xterm is browser-only)
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      // Also load CSS
      await import("@xterm/xterm/css/xterm.css");

      if (disposed || !containerRef.current) return;

      terminal = new Terminal({
        fontFamily: "'JetBrains Mono Variable', monospace",
        fontSize: 13,
        lineHeight: 1.4,
        cursorBlink: true,
        theme: {
          background: "#0a0a0a",
          foreground: "#e4e4e7",
          cursor: "#e4e4e7",
          selectionBackground: "#27272a",
        },
      });

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();

      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.open(containerRef.current);

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      fitAddon.fit();

      terminal.onData((data) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      terminal.onResize(({ cols, rows }) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
      });
      resizeObserver.observe(containerRef.current!);

      connect();

      // Store cleanup for the async context
      return () => {
        resizeObserver.disconnect();
        terminal?.dispose();
      };
    })();

    return () => {
      disposed = true;
      wsRef.current?.close();
      terminal?.dispose();
    };
  }, [connect]);

  if (status !== "running") {
    return (
      <div className="flex h-full items-center justify-center bg-[#0a0a0a] text-sm text-muted-foreground">
        Session is {status}. Start the session to access the terminal.
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full bg-[#0a0a0a] p-1" />;
}
