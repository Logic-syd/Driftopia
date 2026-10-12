import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default defineConfig({
  root: resolve("apps/web"),
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    fs: { allow: [resolve(".")] },
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/socket.io": { target: "http://127.0.0.1:3001", ws: true },
    },
  },
  build: {
    outDir: resolve("dist/web"),
    emptyOutDir: true,
    rollupOptions: { output: { manualChunks: { phaser: ["phaser"] } } },
  },
});
