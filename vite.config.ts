import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api/terminal": { target: "http://localhost:3000", ws: true },
      "/api": "http://localhost:3000",
      "/.well-known": "http://localhost:3000",
    },
  },
  plugins: [tailwindcss(), react()],
  build: {
    outDir: "dist/client",
  },
});
