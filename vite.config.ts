/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/public",
    emptyOutDir: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  test: {
    // Node 25+ defines its own experimental localStorage global, which hides jsdom's Storage and warns when
    // touched. Turning it off gives jsdom tests the browser-like storage (a no-op flag on Node 22).
    execArgv: ["--no-experimental-webstorage"],
    setupFiles: ["src/test-setup.ts"],
  },
});
