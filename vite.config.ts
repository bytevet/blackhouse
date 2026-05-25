import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@server": path.resolve(__dirname, "server"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      // ws:true is needed for both the terminal (xterm) WS and the IDE proxy
      // (code-server upgrades to a WS for its renderer↔editor service) plus
      // /api/browser-ws/* (JPEG frame stream from agent's browser-service).
      "/api": { target: "http://localhost:3000", ws: true },
      "/.well-known": "http://localhost:3000",
    },
  },
  plugins: [tailwindcss(), react()],
  build: {
    outDir: "dist/client",
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@xterm")) return "xterm";
          if (id.includes("shiki")) return "shiki";
        },
      },
    },
  },
});
